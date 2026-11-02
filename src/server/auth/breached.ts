/** Package A (`breached.ts`, Q3, ST-066): offline breached-password list, sorted SHA-1 hex, binary search.
 *
 * Bundled list: a compact HIBP-derived top-100 000 file shipped next to this module (missing until the owner
 * confirms the source and licence). `.env` can name a larger operator file in the same format (for example the
 * HIBP ordered-by-count download), searched in place on the disk. An unreadable or missing list answers
 * `unavailable`; `checkPasswordPolicy` turns that into `breached` only when it was asked to fail closed.
 */
import { createHash } from 'node:crypto'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { BreachedList } from './types'

export const BUNDLED_FILE_NAME = 'breached-top100k.txt'
const HEX_CHARS = 40 // SHA-1
const LINE_BYTES = 41 // 40 hex characters plus `\n` (one fixed width on both list kinds)

const sha1Hex = (password: string) => createHash('sha1').update(password, 'utf8').digest('hex')

export type BreachedSource = { kind: 'bundled' | 'operator' | 'none'; entries: number }

type BreachedLookup = {
  kind: 'bundled' | 'operator' | 'none'
  entries: number
  contains(passwordSha1: string): Promise<boolean | 'unavailable'>
}

/** Only reads whole lines that are exactly 40 hex characters, sorted ascending and without repeats. */
function lookupLines(lines: readonly string[]): (hashHex: string) => Promise<boolean | 'unavailable'> {
  return (hashHex) => {
    let low = 0
    let high = lines.length
    while (low < high) {
      const mid = low + ((high - low) >> 1)
      const probe = lines[mid] ?? ''
      if (probe === hashHex) return Promise.resolve(true)
      if (probe < hashHex) low = mid + 1
      else high = mid
    }
    return Promise.resolve(false)
  }
}

const LINE_PATTERN = /^[0-9a-f]{40}\n$/
const SAMPLES = 64

/** One fixed-width line at `index`, or undefined when it is not 40 lowercase hex characters plus `\n`. */
async function readLine(file: FileHandle, index: number, probe: Buffer): Promise<string | undefined> {
  const read = await file.read(probe, 0, LINE_BYTES, index * LINE_BYTES)
  if (read.bytesRead !== LINE_BYTES) return undefined
  const text = probe.toString('latin1')
  return LINE_PATTERN.test(text) ? text.slice(0, HEX_CHARS) : undefined
}

/** Binary search over a fixed-width file on the disk (the operator file can be gigabytes). */
async function lookupDisk(filePath: string, size: number, hashHex: string): Promise<boolean | 'unavailable'> {
  if (size % LINE_BYTES !== 0) return 'unavailable'
  const file = await open(filePath, 'r')
  try {
    const probe = Buffer.alloc(LINE_BYTES)
    let low = 0
    let high = size / LINE_BYTES
    while (low < high) {
      const mid = low + ((high - low) >> 1)
      const line = await readLine(file, mid, probe)
      if (line === undefined) return 'unavailable'
      if (line === hashHex) return true
      if (line < hashHex) low = mid + 1
      else high = mid
    }
    return false
  } finally {
    await file.close()
  }
}

/** Spot check at load: first, last and evenly spaced lines are well formed and not descending. A full scan would cost gigabytes of reads. */
async function looksSorted(filePath: string, entries: number): Promise<boolean> {
  if (entries === 0) return false
  const file = await open(filePath, 'r')
  try {
    const probe = Buffer.alloc(LINE_BYTES)
    const count = Math.min(entries, SAMPLES)
    let previous = ''
    for (let i = 0; i < count; i += 1) {
      const index = count === 1 ? 0 : Math.round((i * (entries - 1)) / (count - 1))
      const line = await readLine(file, index, probe)
      if (line === undefined || line < previous) return false
      previous = line
    }
    return true
  } finally {
    await file.close()
  }
}

const NO_LIST: BreachedLookup = { kind: 'none', entries: 0, contains: async () => 'unavailable' as const }

/** Loads the bundled list (the file may be absent) and the operator file when `.env` names one. */
export async function loadBreachedList(operatorPath: string | null): Promise<BreachedLookup> {
  if (operatorPath) {
    let size: number | undefined
    try {
      size = (await stat(operatorPath)).size
    } catch {
      // unreadable or missing: falls through to the bundled list
    }
    if (size !== undefined) {
      // A file that exists but is malformed is never replaced silently: the check reports unavailable.
      const entries = size / LINE_BYTES
      if (!Number.isInteger(entries) || !(await looksSorted(operatorPath, entries).catch(() => false))) return NO_LIST
      return {
        kind: 'operator',
        entries,
        contains: (hashHex) => lookupDisk(operatorPath, entries * LINE_BYTES, hashHex),
      }
    }
  }
  const bundled = await tryLoadLines(fileURLToPath(new URL(`./${BUNDLED_FILE_NAME}`, import.meta.url)))
  if (bundled === undefined) return NO_LIST
  return { kind: 'bundled', entries: bundled.length, contains: lookupLines(bundled) }
}

/** Whole lines of `SHA1` or `SHA1:count`, sorted by the hash. A malformed line, a duplicate or an empty list means no list. */
async function tryLoadLines(filePath: string): Promise<string[] | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(filePath, 'latin1')
    const lines: string[] = []
    for (const raw of text.split('\n')) {
      const entry = raw.trim()
      if (entry === '') continue
      const hex = entry.split(':')[0]!.toLowerCase()
      if (!/^[0-9a-f]{40}$/.test(hex)) return undefined
      lines.push(hex)
    }
    if (lines.length === 0) return undefined
    lines.sort()
    for (let i = 1; i < lines.length; i += 1) if (lines[i] === lines[i - 1]) return undefined
    return lines
  } catch {
    return undefined
  }
}

export async function breachedListService(operatorPath: string | null): Promise<BreachedList> {
  const loaded = await loadBreachedList(operatorPath)
  return {
    contains: (password) => loaded.contains(sha1Hex(password)),
    source: (): BreachedSource => ({ kind: loaded.kind, entries: loaded.entries }),
  }
}

/** A list that loads on first use, from the operator path as the settings say it then (one load per process). */
export function lazyBreachedList(path: () => string | null): BreachedList {
  let list: Promise<BreachedList> | undefined
  return {
    contains: async (password) => (await (list ??= breachedListService(path()))).contains(password),
    source: () => ({ kind: 'none', entries: 0 }),
  }
}
