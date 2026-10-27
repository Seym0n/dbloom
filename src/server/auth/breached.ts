/** Package A (`breached.ts`, Q3, ST-066): offline breached-password list, sorted SHA-1 hex, binary search.
 *
 * Bundled list: a compact HIBP-derived top-100 000 file shipped next to this module (missing until the owner
 * confirms the source and licence). `.env` can name a larger operator file in the same format (for example the
 * HIBP ordered-by-count download), searched in place on the disk. An unreadable or missing list answers
 * `unavailable`; `checkPasswordPolicy` turns that into `breached` only when it was asked to fail closed.
 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { open } from 'node:fs/promises'
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
      const read = await file.read(probe, 0, LINE_BYTES, mid * LINE_BYTES)
      if (read.bytesRead !== LINE_BYTES) return 'unavailable'
      const line = probe.subarray(0, HEX_CHARS).toString('latin1')
      if (line === hashHex) return true
      if (line < hashHex) low = mid + 1
      else high = mid
    }
    return false
  } finally {
    await file.close()
  }
}

/** Loads the bundled list (the file may be absent) and the operator file when `.env` names one. */
export async function loadBreachedList(operatorPath: string | null): Promise<BreachedLookup> {
  if (operatorPath) {
    try {
      const size = (await stat(operatorPath)).size
      const entries = size / LINE_BYTES
      if (Number.isInteger(entries)) {
        return {
          kind: 'operator',
          entries,
          contains: (hashHex) => lookupDisk(operatorPath, entries * LINE_BYTES, hashHex),
        }
      }
    } catch {
      // falls through to the bundled list
    }
  }
  const bundled = await tryLoadLines(fileURLToPath(new URL(`./${BUNDLED_FILE_NAME}`, import.meta.url)))
  if (bundled === undefined) return { kind: 'none', entries: 0, contains: async () => 'unavailable' as const }
  return { kind: 'bundled', entries: bundled.length, contains: lookupLines(bundled) }
}

/** Whole lines of `SHA1` or `SHA1:count`, sorted by the hash; an unreadable line means no list. */
async function tryLoadLines(filePath: string): Promise<string[] | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(filePath, 'latin1')
    const lines = text
      .split('\n')
      .map((raw) => raw.split(':')[0]!.trim())
      .filter((hex) => hex.length === HEX_CHARS && /^[0-9a-f]{40}$/.test(hex))
    if (lines.length === 0) return undefined
    lines.sort()
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
