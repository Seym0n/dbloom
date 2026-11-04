import { describe, expect, it } from 'vitest'
import { RECALL_KEY, clearRecall, preselected, readRecall, saveRecall } from '~/lib/recall'

// ST-074: the direct login page remembers a server and a user name, never a password.

const fake = (initial: Record<string, string> = {}) => {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
  }
}

describe('recall storage', () => {
  it('saves only the server and the user name and reads them back', () => {
    const s = fake()
    saveRecall(s, { server: 'db.internal:3306', username: 'ann', password: 'secret' } as never)
    expect(JSON.parse(s.data[RECALL_KEY]!)).toEqual({ server: 'db.internal:3306', username: 'ann' })
    expect(readRecall(s)).toEqual({ server: 'db.internal:3306', username: 'ann' })
    expect(JSON.stringify(s.data)).not.toContain('secret')
  })

  it('an empty, oversize or control-character value is not saved', () => {
    const s = fake()
    for (const v of [{ server: '', username: 'a' }, { server: 'x', username: '' }, { server: 'x'.repeat(256), username: 'a' }, { server: 'h', username: 'a'.repeat(129) }, { server: 'h\nx', username: 'a' }, { server: 'h', username: 'a\u0000' }]) saveRecall(s, v)
    expect(s.data).toEqual({})
  })

  it('a broken or foreign entry reads as nothing', () => {
    for (const raw of ['not json', '{}', '{"server":1,"username":"a"}', '{"server":"h","username":""}', '[]', 'null', '{"server":"h\n","username":"a"}']) {
      expect(readRecall(fake({ [RECALL_KEY]: raw })), raw).toBeNull()
    }
    expect(readRecall(fake())).toBeNull()
    expect(readRecall(undefined)).toBeNull()
  })

  it('a storage that throws is the same as none; clear removes the entry', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('blocked') } }
    expect(readRecall(broken)).toBeNull()
    expect(() => saveRecall(broken, { server: 'h', username: 'a' })).not.toThrow()
    expect(() => clearRecall(broken)).not.toThrow()
    const s = fake()
    saveRecall(s, { server: 'h', username: 'a' })
    clearRecall(s)
    expect(readRecall(s)).toBeNull()
  })
})

describe('which server is preselected', () => {
  const r = { server: '127.0.0.1:33064', username: 'root' }
  it('the remembered one when it is on the named list, compared without case and spaces', () => {
    expect(preselected(r, ['127.0.0.1:33064', '127.0.0.1:33061'])).toEqual(r)
    expect(preselected({ server: ' DB.Example:3306 ', username: 'a' }, ['db.example:3306'])).toMatchObject({ username: 'a' })
  })
  it('none when it is no longer named; the remembered one when there is no list; none when nothing is remembered', () => {
    expect(preselected(r, ['127.0.0.1:33061'])).toBeNull()
    expect(preselected(r, [])).toEqual(r)
    expect(preselected(r, undefined)).toEqual(r)
    expect(preselected(null, ['x:1'])).toBeNull()
  })
})
