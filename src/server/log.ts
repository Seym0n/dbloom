/**
 * The one structured logger (FR-SVR-020): JSON lines on stdout, level from `DBLOOM_LOG_LEVEL` (default `info`), a
 * request id per request (set by the gate), no secrets. The audit stream (`audit.ts`) stays separate; CLI output meant
 * for humans does not use this module.
 *
 * Redaction rules (the log never carries a credential even when a caller passes one by mistake):
 * - fields named like a secret (authorization, cookie, password, token, body, ...) are replaced by `[redacted]`;
 * - query values of sensitive keys, and token-shaped values (long base64url / hex runs), are replaced in every URL
 *   and in every string value (`redactText`);
 * - `Bearer <x>` and `Basic <x>` credentials in free text are replaced.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Fields = Record<string, unknown>

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
export const REDACTED = '[redacted]'

const SECRET_FIELD =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|passphrase|secret|token|body|payload|apikey|x-csrf.*|x-api-key|code|key)$|(password|passphrase|secret|token|cookie|credential|api[-_]?key)/i
const SECRET_QUERY_KEY = /(token|code|key|secret|pass|auth|session|sig|invite|recover|otp|csrf|credential|bearer|jwt|nonce|state)/i
/** A value that looks like a token: 24+ chars of base64url / hex / dots without spaces. */
const TOKEN_SHAPED = /^[A-Za-z0-9_\-.~+/=]{24,}$/

/** Query string with sensitive and token-shaped values replaced; keys stay. */
export function redactQuery(query: string): string {
  const q = query.startsWith('?') ? query.slice(1) : query
  if (q === '') return ''
  const parts = q.split('&').map((pair) => {
    const i = pair.indexOf('=')
    if (i < 0) return TOKEN_SHAPED.test(pair) ? REDACTED : pair
    const key = pair.slice(0, i)
    let value = pair.slice(i + 1)
    let decoded = value
    try {
      decoded = decodeURIComponent(value)
    } catch {
      // keep raw
    }
    if (SECRET_QUERY_KEY.test(key) || TOKEN_SHAPED.test(decoded)) value = REDACTED
    return `${key}=${value}`
  })
  return `?${parts.join('&')}`
}

/** Path plus redacted query from a URL or a request target (`/path?x=1`). Never throws. */
export function redactUrl(target: string): string {
  const hash = target.indexOf('#')
  const t = hash >= 0 ? target.slice(0, hash) : target
  const q = t.indexOf('?')
  if (q < 0) return t
  return `${t.slice(0, q)}${redactQuery(t.slice(q))}`
}

/** Free text: URLs inside get their query redacted, bearer / basic credentials are replaced. */
export function redactText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/(\?[^\s"'<>]*)/g, (m) => redactQuery(m))
}

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) }
  if (depth > 4) return '[deep]'
  if (value instanceof Headers) return scrub(Object.fromEntries(value.entries()), depth)
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1))
  const out: Fields = {}
  for (const [k, v] of Object.entries(value as Fields)) out[k] = SECRET_FIELD.test(k) ? REDACTED : scrub(v, depth + 1)
  return out
}

export function redactFields(fields: Fields): Fields {
  return scrub(fields, 0) as Fields
}

export type LoggerOptions = {
  level: () => LogLevel
  write?: (line: string) => void
  now?: () => Date
  base?: Fields
}

export type Logger = {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
  /** Same logger with extra fields on every line (for example `{ requestId }`). */
  child(fields: Fields): Logger
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`))
  const now = options.now ?? (() => new Date())
  const emit = (level: LogLevel, msg: string, fields: Fields | undefined) => {
    if (ORDER[level] < ORDER[options.level()]) return
    const line = { t: now().toISOString(), level, msg: redactText(msg), ...redactFields({ ...options.base, ...fields }) }
    let text: string
    try {
      text = JSON.stringify(line)
    } catch {
      text = JSON.stringify({ t: line.t, level, msg: line.msg })
    }
    write(text)
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...options, base: { ...options.base, ...fields } }),
  }
}

/**
 * Level of the process logger: `DBLOOM_LOG_LEVEL`, default `info`. Debug in production without `DBLOOM_ALLOW_DEBUG`
 * is refused by the config at startup (config.ts); should it reach here anyway it is treated as `info`.
 */
export function levelFromEnv(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.DBLOOM_LOG_LEVEL ?? '').trim().toLowerCase()
  const level: LogLevel = raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info'
  if (level === 'debug' && env.NODE_ENV === 'production' && env.DBLOOM_ALLOW_DEBUG?.trim().toLowerCase() !== 'true') return 'info'
  return level
}

export const log: Logger = createLogger({ level: () => levelFromEnv() })
