import { describe, expect, test } from 'vitest'
import {
  CONNECTION_MESSAGE,
  mapMysqlError,
  StructureRefusal,
  toClientError,
} from '~/server/structure/errors'

const server = (errno: number, sqlMessage: string) =>
  Object.assign(new Error(sqlMessage), {
    errno,
    code: 'ER_X',
    sqlMessage,
    sql: "SELECT 'secret'",
    stack: 'STACK',
  })

describe('mapMysqlError', () => {
  test.each([
    [1044, true],
    [1142, true],
    [1143, true],
    [1050, true],
    [1051, true],
    [1146, true],
    [1054, true],
    [1062, true],
    [1064, true],
    [1091, true],
    [1215, true],
    [1216, true],
    [1217, true],
    [1451, true],
    [1452, true],
    [1005, true],
    [3730, true],
    [1553, true],
    [1822, true],
    [1825, true],
    [1826, true],
    [1828, true],
    [1829, true],
    [1830, true],
    [1832, true],
    [1833, true],
    [1834, true],
    [3734, true],
    [3780, true],
    [3819, true],
    [4025, true],
    [1205, true],
    [1213, true],
    [3024, true],
    [1317, true],
    [9999, false],
  ])('errno %i has a hint: %s', (errno, hinted) => {
    const out = mapMysqlError(server(errno, 'server text'), 0)
    expect(out.message).toBe('server text')
    expect(out.errno).toBe(errno)
    expect(Boolean(out.hint)).toBe(hinted)
  })

  test('output carries no sql, stack or extra fields', () => {
    const out = mapMysqlError(server(1062, 'Duplicate entry'), 2)
    expect(Object.keys(out).sort()).toEqual(['code', 'errno', 'hint', 'message'])
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(JSON.stringify(out)).not.toContain('STACK')
  })

  test('connection errors fall back to the uniform text', () => {
    const out = mapMysqlError(
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3306'), {
        code: 'ECONNREFUSED',
        errno: -111,
      }),
      0,
    )
    expect(out).toEqual({ errno: null, code: 'ECONNREFUSED', message: CONNECTION_MESSAGE })
    expect(mapMysqlError('weird').message).toBe(CONNECTION_MESSAGE)
  })

  test('toClientError keeps a stable code prefix', () => {
    expect(toClientError(new StructureRefusal('stale_plan', 'changed')).message).toBe(
      'stale_plan: changed',
    )
  })
})
