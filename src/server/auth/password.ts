/** Package A (`password.ts`, FR-AUT-005, ST-063 to 067): normalisation, policy, Argon2id PHC, semaphore, dummy hash.
 *
 * Reads `PASSWORD_NORMALISATION` only (the one switch point), runs every Argon2 job of package A through one
 * limiter so the memory bound of FR-AUT-005 (2 × 64 MiB plus base) holds for login and vault jobs together;
 * `runArgon2` is the import point for the other package A files. Nothing of a password reaches an exception
 * message, a log call or a returned object (section 9).
 */
import { argon2 as argon2Async, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  ARGON2_LOGIN_DEFAULT,
  ARGON2_MAX_CONCURRENT,
  ARGON2_QUEUE_MAX,
  ARGON2_SALT_BYTES,
  ARGON2_TAG_BYTES,
  PASSWORD_MAX_BYTES,
  PASSWORD_MAX_CHARS,
  PASSWORD_NORMALISATION,
  type Argon2Params,
  type BreachedList,
  type PasswordRejectReason,
  type PasswordService,
  type Secret,
  AuthError,
} from './types'
import { secret, reveal } from './secret'

const PHC_REGEX = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/

// ---- Shared Argon2 job slot ---------------------------------------------------------------------------------

const waiting: Array<() => void> = []
let active = 0

/**
 * One job through the limiter; throws `AuthError('auth_throttled')` beyond the queue bound
 * (FR-AUT-005: `hash` and every other package A job share this slot).
 */
export async function runArgon2<T>(task: () => Promise<T>): Promise<T> {
  if (active >= ARGON2_MAX_CONCURRENT && waiting.length >= ARGON2_QUEUE_MAX) {
    throw new AuthError('auth_throttled')
  }
  await new Promise<void>((grab) => {
    if (active < ARGON2_MAX_CONCURRENT) {
      active += 1
      grab()
      return
    }
    // The releasing job hands its slot over, so `active` is not incremented here (it leaked a slot per queued job).
    waiting.push(grab)
  })
  try {
    return await task()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active = Math.max(0, active - 1)
  }
}

type Argon2Input = { message: Buffer; nonce: Buffer; memoryKiB: number; passes: number; parallelism: number }

/** One Argon2id tag (runs on the libuv pool through `runArgon2`). */
export function argon2Tag(params: Argon2Input): Promise<Buffer> {
  return runArgon2(
    () =>
      new Promise<Buffer>((resolve, fail) => {
        argon2Async(
          'argon2id',
          {
            message: params.message,
            nonce: params.nonce,
            parallelism: params.parallelism,
            tagLength: ARGON2_TAG_BYTES,
            memory: params.memoryKiB,
            passes: params.passes,
          },
          (err, tag) => {
            if (err) fail(new Error('argon2_job_failed', { cause: err }))
            else resolve(tag)
          },
        )
      }),
  )
}

// ---- PHC encode / parse -------------------------------------------------------------------------------------

export type ParsedPhc = { params: Argon2Params; salt: Buffer; tag: Buffer }

export function parsePhc(phc: string): ParsedPhc | undefined {
  const match = PHC_REGEX.exec(phc)
  if (!match) return undefined
  const groups = match.slice(1) as unknown as [string, string, string, string, string]
  const [m, t, p, saltText, tagText] = groups
  const salt = Buffer.from(saltText, 'base64')
  const tag = Buffer.from(tagText, 'base64')
  if (salt.length !== ARGON2_SALT_BYTES || tag.length !== ARGON2_TAG_BYTES) return undefined
  const params = { memoryKiB: Number(m), passes: Number(t), parallelism: Number(p) }
  if (!withinPhcBounds(params)) return undefined
  return { params, salt, tag }
}

/** Sanity bounds for a stored PHC: a damaged or hostile record must not start an unbounded Argon2 job (or `Infinity`). */
const PHC_MAX_MEMORY_KIB = 1024 * 1024
const PHC_MAX_PASSES = 64
const PHC_MAX_PARALLELISM = 16
const withinPhcBounds = (p: Argon2Params) =>
  Number.isSafeInteger(p.memoryKiB) &&
  Number.isSafeInteger(p.passes) &&
  Number.isSafeInteger(p.parallelism) &&
  p.parallelism >= 1 &&
  p.parallelism <= PHC_MAX_PARALLELISM &&
  p.passes >= 1 &&
  p.passes <= PHC_MAX_PASSES &&
  p.memoryKiB >= 8 * p.parallelism &&
  p.memoryKiB <= PHC_MAX_MEMORY_KIB

const unpad = (v: Buffer) => v.toString('base64').replace(/=+$/, '')

export function encodePhc(tag: Buffer, salt: Buffer, params: Argon2Params): string {
  return [
    '$argon2id',
    'v=19',
    `m=${params.memoryKiB},t=${params.passes},p=${params.parallelism}`,
    unpad(salt),
    unpad(tag),
  ].join('$')
}

/** Constant-time compare of two tags of equal length: compares hashes so `timingSafeEqual` applies (section 5.4). */
const sameTag = (a: Buffer, b: Buffer) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

// ---- Policy (FR-AUT-005, ST-063 to 066) ---------------------------------------------------------------------

const codePoints = (s: string) => [...s].length

/** `PASSWORD_NORMALISATION`; also the service's first step before every length check and hash. */
export const normalisePassword = (raw: string) => raw.normalize(PASSWORD_NORMALISATION)

const containsUsername = (password: string, username: string) => {
  const name = username.trim().toLowerCase()
  // Very short names match all over; the policy stays at meaningful containment.
  if (name.length < 3) return false
  return password.toLowerCase().includes(name)
}

export async function checkPasswordPolicy(
  password: string,
  breached: BreachedList,
  ctx: { username: string; minLength: number; breachedCheck: boolean; failClosed: boolean },
): Promise<{ reason: PasswordRejectReason | null; breachedListUnavailable: boolean }> {
  const pw = normalisePassword(password)
  if (codePoints(pw) > PASSWORD_MAX_CHARS || Buffer.byteLength(pw, 'utf8') > PASSWORD_MAX_BYTES) {
    return { reason: 'too_long', breachedListUnavailable: false }
  }
  if (codePoints(pw) < ctx.minLength) return { reason: 'too_short', breachedListUnavailable: false }
  if (containsUsername(pw, ctx.username)) return { reason: 'contains_username', breachedListUnavailable: false }
  if (ctx.breachedCheck) {
    const hit = await breached.contains(pw)
    if (hit === 'unavailable') {
      // Fail-closed only when the caller asks (FR-AUT-005: `failClosed`), reported either way.
      return { reason: ctx.failClosed ? 'breached' : null, breachedListUnavailable: true }
    }
    if (hit) return { reason: 'breached', breachedListUnavailable: false }
  }
  return { reason: null, breachedListUnavailable: false }
}

// ---- Service ------------------------------------------------------------------------------------------------

export function createPasswordService(breached: BreachedList): PasswordService {
  // Dummy-verify target: a PHC hash of a random password made at first use, same cost as a real verify.
  const dummyPassword: Secret<string> = secret(randomBytes(32).toString('base64'))
  let dummyPhc: string | undefined
  let dummyJob: Promise<void> | undefined

  /** Seals the dummy PHC once; later calls wait for the same promise. */
  const ensureDummy = (): Promise<void> => {
    dummyJob ??= (async () => {
      const salt = randomBytes(ARGON2_SALT_BYTES)
      const tag = await argon2Tag({
        message: Buffer.from(reveal(dummyPassword), 'utf8'),
        nonce: salt,
        ...ARGON2_LOGIN_DEFAULT,
      })
      dummyPhc = encodePhc(tag, salt, ARGON2_LOGIN_DEFAULT)
    })()
    return dummyJob
  }

  return {
    normalise: normalisePassword,
    check: (password, ctx) => checkPasswordPolicy(password, breached, ctx),
    async hash(password, params) {
      const pw = normalisePassword(password)
      const salt = randomBytes(ARGON2_SALT_BYTES)
      const tag = await argon2Tag({ message: Buffer.from(pw, 'utf8'), nonce: salt, ...params })
      return encodePhc(tag, salt, params)
    },
    async verify(phc, password) {
      const parsed = parsePhc(phc)
      if (!parsed) {
        await this.dummyVerify(password)
        return false
      }
      const pw = normalisePassword(password)
      const tag = await argon2Tag({ message: Buffer.from(pw, 'utf8'), nonce: parsed.salt, ...parsed.params })
      return sameTag(tag, parsed.tag)
    },
    needsRehash(phc, params) {
      const parsed = parsePhc(phc)
      if (!parsed) return true
      const ok =
        parsed.params.memoryKiB >= params.memoryKiB &&
        parsed.params.passes >= params.passes &&
        parsed.params.parallelism >= params.parallelism
      return !ok
    },
    async dummyVerify(password) {
      await ensureDummy()
      const pw = normalisePassword(password)
      const parsed = parsePhc(dummyPhc ?? '')
      if (!parsed) return false
      const tag = await argon2Tag({ message: Buffer.from(pw, 'utf8'), nonce: parsed.salt, ...parsed.params })
      sameTag(tag, parsed.tag)
      return false as const
    },
  }
}
