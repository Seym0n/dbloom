import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FOLDER_ID, folderFileId, listFolder, resolveFolderFile } from '../src/server/io/folder'

let root: string
let dir: string
let outside: string
let canSymlink = true

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dbloom-folder-'))
  dir = join(root, 'import')
  outside = join(root, 'outside')
  mkdirSync(dir)
  mkdirSync(outside)
  writeFileSync(join(dir, 'dump.sql'), 'SELECT 1;')
  writeFileSync(join(dir, 'Rows.CSV.gz'), 'x')
  writeFileSync(join(dir, 'notes.txt'), 'no')
  writeFileSync(join(dir, '.hidden.sql'), 'no')
  mkdirSync(join(dir, 'sub.sql'))
  writeFileSync(join(outside, 'secret.sql'), 'SELECT secret;')
  try {
    symlinkSync(join(outside, 'secret.sql'), join(dir, 'link.sql'), 'file')
  } catch {
    canSymlink = false
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('server import folder', () => {
  it('lists only allowed regular files, sorted, with ids that carry no name', async () => {
    const list = await listFolder(dir)
    expect(list.map((f) => f.name)).toEqual(['dump.sql', 'Rows.CSV.gz'])
    expect(list[0]?.bytes).toBe(9)
    for (const f of list) expect(f.id).toMatch(FOLDER_ID)
  })

  it('resolves an id from the listing and nothing else', async () => {
    const [f] = await listFolder(dir)
    const src = await resolveFolderFile(dir, f!.id)
    expect(src).toMatchObject({ kind: 'folder', name: 'dump.sql', bytes: 9 })
    expect(src.path.endsWith('dump.sql')).toBe(true)
  })

  it.each(['../etc/passwd', '/etc/passwd', '..\\x', 'dump.sql', 'fld_zz', folderFileId('missing.sql'), folderFileId('../outside/secret.sql')])(
    'refuses %s',
    async (id) => {
      await expect(resolveFolderFile(dir, id)).rejects.toMatchObject({ error: { code: 'path_refused' } })
    },
  )

  it('does not list or open a symbolic link', async (ctx) => {
    if (!canSymlink) return ctx.skip()
    expect((await listFolder(dir)).map((f) => f.name)).not.toContain('link.sql')
    await expect(resolveFolderFile(dir, folderFileId('link.sql'))).rejects.toMatchObject({ error: { code: 'path_refused' } })
  })

  it('works through a symlinked folder path by its real path, and refuses a missing folder', async (ctx) => {
    await expect(listFolder(join(root, 'missing'))).rejects.toMatchObject({ error: { code: 'not_enabled' } })
    if (!canSymlink) return ctx.skip()
    const alias = join(root, 'alias')
    symlinkSync(dir, alias, 'dir')
    expect((await listFolder(alias)).map((f) => f.name)).toEqual(['dump.sql', 'Rows.CSV.gz'])
  })
})
