/**
 * Server import folder (FR-IO-013, ST-153, SEC-PLG-002, SEC-SAU-305). Off unless `DBLOOM_IMPORT_DIR` is set.
 * A file is addressed by an id derived from its name in a fresh listing; the client never supplies a name or a
 * path. The folder is read flat. A listed file must be a regular file whose real path is its own path inside
 * the real folder (no symbolic link in the folder or as the file, no hard-to-spot `..`), readable, and it is
 * opened with `O_NOFOLLOW` where the platform has it.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { failure, type ImportSource } from './import-source'

export const FOLDER_ID = /^fld_[0-9a-f]{32}$/
export const FOLDER_ALLOWED_NAME = /\.(sql|csv|json)(\.(gz|zip))?$/i
const MAX_LISTED = 1000

export type FolderEntry = { id: string; name: string; bytes: number }

export const folderFileId = (name: string): string =>
  `fld_${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 32)}`

const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

async function realDir(dir: string): Promise<string> {
  try {
    const real = await realpath(dir)
    const st = await lstat(real)
    if (!st.isDirectory()) throw new Error('not a directory')
    return real
  } catch {
    throw failure('not_enabled', 'The server import folder is not available')
  }
}

/** Checks one directory entry; returns its size or undefined when it must not be offered. */
async function checkFile(dirReal: string, name: string): Promise<{ path: string; bytes: number } | undefined> {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.')) {
    return undefined
  }
  if (!FOLDER_ALLOWED_NAME.test(name)) return undefined
  const path = join(dirReal, name)
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink() || !st.isFile()) return undefined
    const real = await realpath(path)
    if (!samePath(real, path)) return undefined
    if (!real.startsWith(dirReal.endsWith(sep) ? dirReal : dirReal + sep)) return undefined
    // Readable: opening is the test (no-follow where the platform has the flag).
    const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
    const fh = await open(path, fsConstants.O_RDONLY | noFollow)
    await fh.close()
    return { path, bytes: st.size }
  } catch {
    return undefined
  }
}

/** Regular, allowed, readable files of the folder, sorted by name (at most 1000). */
export async function listFolder(dir: string): Promise<FolderEntry[]> {
  const dirReal = await realDir(dir)
  const names = (await readdir(dirReal)).sort((a, b) => a.localeCompare(b))
  const out: FolderEntry[] = []
  for (const name of names) {
    if (out.length >= MAX_LISTED) break
    const ok = await checkFile(dirReal, name)
    if (ok) out.push({ id: folderFileId(name), name, bytes: ok.bytes })
  }
  return out
}

/** The import source for a folder id; any id that does not match a file of a fresh listing is refused. */
export async function resolveFolderFile(dir: string, id: string): Promise<ImportSource> {
  if (!FOLDER_ID.test(id)) throw failure('path_refused', 'The file is not in the import folder')
  const dirReal = await realDir(dir)
  const names = await readdir(dirReal)
  for (const name of names) {
    if (folderFileId(name) !== id) continue
    const ok = await checkFile(dirReal, name)
    if (!ok) break
    return { id, kind: 'folder', path: ok.path, name, bytes: ok.bytes }
  }
  throw failure('path_refused', 'The file is not in the import folder')
}
