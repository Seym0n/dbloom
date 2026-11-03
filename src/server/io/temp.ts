import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { JOB_RETENTION_MS } from './types'

/**
 * Temp directory, staged files and quota of module io (FR-IO-012, section 5.6, ST-155).
 * Files are named by 32 random hex digits (mode 0600) and never by a client-supplied name; the display name
 * is metadata only (SEC-SAU-304). Every file is bound to the session and user that created it.
 */

export type TempOwner = { sessionId: string; user: string }

export type TempErrorCode =
  'upload_too_large' | 'quota_full' | 'upload_failed' | 'upload_interrupted'

export class TempError extends Error {
  constructor(
    public code: TempErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TempError'
  }
}

export const TEMP_ID = /^[0-9a-f]{32}$/
const HOUR_MS = 3_600_000

// ---- Directory ---------------------------------------------------------------------------------------

/**
 * Creates the directory (0700) and refuses a symlinked or world-writable path. A final symlink is refused
 * even when it points to a safe place: the path in `.env` must be the real directory.
 */
export function prepareTempDir(dir: string, forbidInside: string[] = []): string {
  const path = resolve(dir)
  for (const f of forbidInside) {
    const rel = relative(resolve(f), path)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new Error('The temporary directory must not be inside a protected directory')
    }
  }
  if (existsSync(path)) {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) throw new Error('The temporary directory must not be a symbolic link')
    if (!st.isDirectory()) throw new Error('The temporary directory path is not a directory')
    if (process.platform !== 'win32' && (st.mode & 0o002) !== 0) {
      throw new Error('The temporary directory must not be world-writable')
    }
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  if (process.platform !== 'win32') chmodSync(path, 0o700)
  return path
}

// ---- Registry --------------------------------------------------------------------------------------------

export type TempKind = 'upload' | 'spool'

export type TempFile = {
  id: string
  kind: TempKind
  path: string
  bytes: number
  /** Display name for messages only. */
  name: string
  /** Declared format of an upload. */
  format?: string
  owner: TempOwner
  createdAt: number
  retainUntil: number
}

export type TempOptions = {
  dir: string
  quotaBytes: number
  now?: () => number
  /** Staged and spool files one owner may hold at the same time. */
  maxFilesPerOwner?: number
  retentionMs?: number
}

export interface StageWriter {
  readonly id: string
  readonly path: string
  readonly bytes: number
  /** Appends a chunk; throws `TempError` when the size limit or the quota is exceeded (the file is then removed). */
  write(chunk: Uint8Array): Promise<void>
  /** Completes the file and registers it. */
  commit(): Promise<TempFile>
  /** Removes the partial file. Safe to call more than once and after `commit`/failure. */
  abort(): Promise<void>
}

export class TempStore {
  readonly dir: string
  private files = new Map<string, TempFile>()
  /** Bytes of files being written. */
  private inflight = new Map<string, number>()
  private now: () => number
  private maxPerOwner: number
  private retentionMs: number
  private timer?: NodeJS.Timeout

  constructor(private opts: TempOptions) {
    this.dir = prepareTempDir(opts.dir)
    this.now = opts.now ?? Date.now
    this.maxPerOwner = opts.maxFilesPerOwner ?? 10
    this.retentionMs = opts.retentionMs ?? JOB_RETENTION_MS
  }

  get quotaBytes(): number {
    return this.opts.quotaBytes
  }

  usedBytes(): number {
    let n = 0
    for (const f of this.files.values()) n += f.bytes
    for (const b of this.inflight.values()) n += b
    return n
  }

  private countOf(owner: TempOwner): number {
    let n = 0
    for (const f of this.files.values()) if (sameOwner(f.owner, owner)) n++
    return n
  }

  /**
   * Starts a file. `maxBytes` is the size limit of this file (upload limit); the quota covers all files.
   * The file is created exclusively (`wx`) with mode 0600 under a random name.
   */
  async begin(
    owner: TempOwner,
    kind: TempKind,
    meta: { name: string; format?: string; maxBytes: number },
  ): Promise<StageWriter> {
    if (this.countOf(owner) + this.ownInflight(owner) >= this.maxPerOwner) {
      throw new TempError('quota_full', 'Too many staged files; remove one first')
    }
    if (this.usedBytes() >= this.opts.quotaBytes)
      throw new TempError('quota_full', 'Temporary storage is full')
    const id = randomBytes(16).toString('hex')
    const path = join(this.dir, id)
    let handle: FileHandle
    try {
      handle = await open(path, 'wx', 0o600)
    } catch {
      throw new TempError('upload_failed', 'The file could not be stored')
    }
    this.inflight.set(id, 0)
    this.inflightOwner.set(id, owner)
    let bytes = 0
    let closed = false
    const inflight = this.inflight
    const inflightOwner = this.inflightOwner
    const used = () => this.usedBytes()
    const quota = this.opts.quotaBytes
    const register = (f: TempFile) => void this.files.set(f.id, f)
    const stamp = () => this.now()
    const retention = this.retentionMs
    const finish = async (remove: boolean) => {
      if (closed) return
      closed = true
      inflight.delete(id)
      inflightOwner.delete(id)
      await handle.close().catch(() => undefined)
      if (remove) await rm(path, { force: true }).catch(() => undefined)
    }
    return {
      id,
      path,
      get bytes() {
        return bytes
      },
      async write(chunk) {
        if (closed) throw new TempError('upload_failed', 'The file could not be stored')
        if (bytes + chunk.length > meta.maxBytes) {
          await finish(true)
          throw new TempError('upload_too_large', 'The file is larger than the limit')
        }
        if (used() + chunk.length > quota) {
          await finish(true)
          throw new TempError('quota_full', 'Temporary storage is full')
        }
        try {
          await handle.write(chunk)
        } catch {
          await finish(true)
          throw new TempError('upload_failed', 'The file could not be stored')
        }
        bytes += chunk.length
        inflight.set(id, bytes)
      },
      async commit() {
        if (closed) throw new TempError('upload_failed', 'The file could not be stored')
        try {
          await handle.sync()
        } catch {
          await finish(true)
          throw new TempError('upload_failed', 'The file could not be stored')
        }
        await finish(false)
        const at = stamp()
        const file: TempFile = {
          id,
          kind,
          path,
          bytes,
          name: meta.name,
          format: meta.format,
          owner,
          createdAt: at,
          retainUntil: at + retention,
        }
        register(file)
        return file
      },
      abort: () => finish(true),
    }
  }

  private inflightOwner = new Map<string, TempOwner>()
  private ownInflight(owner: TempOwner): number {
    let n = 0
    for (const o of this.inflightOwner.values()) if (sameOwner(o, owner)) n++
    return n
  }

  /** The file of this owner, or `undefined` (unknown id and foreign id look the same). */
  get(id: string, owner: TempOwner): TempFile | undefined {
    if (!TEMP_ID.test(id)) return undefined
    const f = this.files.get(id)
    return f && sameOwner(f.owner, owner) ? f : undefined
  }

  /** Extends the retention of a file, e.g. while a job that reads it is alive. */
  retain(id: string, until: number): void {
    const f = this.files.get(id)
    if (f && until > f.retainUntil) f.retainUntil = until
  }

  async remove(id: string): Promise<boolean> {
    const f = this.files.get(id)
    if (!f) return false
    this.files.delete(id)
    await rm(f.path, { force: true }).catch(() => undefined)
    return true
  }

  async dropSession(sessionId: string): Promise<number> {
    let n = 0
    for (const f of [...this.files.values()]) {
      if (f.owner.sessionId === sessionId && (await this.remove(f.id))) n++
    }
    return n
  }

  /**
   * Shutdown: removes every staged and spool file, registered or not (the jobs that owned them end with the
   * process), and returns the count. Only files with a 32-hex name are touched.
   */
  async removeAll(): Promise<number> {
    let n = 0
    for (const f of [...this.files.values()]) if (await this.remove(f.id)) n++
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return n
    }
    for (const name of names) {
      if (!TEMP_ID.test(name)) continue
      try {
        rmSync(join(this.dir, name), { force: true })
        n++
      } catch {
        // busy or gone
      }
    }
    return n
  }

  /**
   * Removes files past their retention and leftovers of earlier runs: files in the directory that carry a
   * 32-hex name, are not registered and are older than the retention.
   */
  async sweep(at: number = this.now()): Promise<number> {
    let n = 0
    for (const f of [...this.files.values()]) {
      if (f.retainUntil <= at && (await this.remove(f.id))) n++
    }
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return n
    }
    for (const name of names) {
      if (!TEMP_ID.test(name) || this.files.has(name) || this.inflight.has(name)) continue
      try {
        const st = statSync(join(this.dir, name))
        if (st.isFile() && at - st.mtimeMs >= this.retentionMs) {
          rmSync(join(this.dir, name), { force: true })
          n++
        }
      } catch {
        // gone meanwhile
      }
    }
    return n
  }

  /** Hourly sweep (ST-155); the timer does not keep the process alive. */
  startSweeper(intervalMs: number = HOUR_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), intervalMs)
    this.timer.unref()
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

export const sameOwner = (a: TempOwner, b: TempOwner) =>
  a.sessionId === b.sessionId && a.user === b.user
