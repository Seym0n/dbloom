import { describe, expect, it } from 'vitest'
import { orderByDependency, foreignKeyTargets, SqlWriter, splitCreateTable, writeSql } from '../src/server/io/sql-writer'
import type { SqlEvent } from '../src/server/io/sql-writer'
import { sqlExportOptions } from '../src/server/io/types'
import type { ColumnInfo, SqlExportOptions } from '../src/server/io/types'

const opts = (o: Partial<SqlExportOptions> = {}): SqlExportOptions => sqlExportOptions.parse(o)
const at = new Date(Date.UTC(2026, 9, 27, 12, 0, 0))
const header: SqlEvent = { type: 'header', dbloomVersion: '1.0.0', serverVersion: '8.4.13', generatedAt: at }

const USERS = [
  'CREATE TABLE `users` (',
  '  `id` int NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(50) DEFAULT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4',
].join('\n')

const ORDERS = [
  'CREATE TABLE `orders` (',
  '  `oid` bigint unsigned NOT NULL,',
  '  `uid` int NOT NULL,',
  '  `note` text,',
  '  PRIMARY KEY (`oid`),',
  '  UNIQUE KEY `u` (`note`(20)),',
  '  KEY `uid` (`uid`),',
  '  CONSTRAINT `fk_u` FOREIGN KEY (`uid`) REFERENCES `users` (`id`) ON DELETE CASCADE',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
].join('\n')

const cols: ColumnInfo[] = [
  { name: 'id', kind: 'int' },
  { name: 'name', kind: 'varchar' },
]

const rowBatch = (table: string, rows: (string | null | Buffer)[][], columns = cols): SqlEvent => ({
  type: 'row-batch',
  database: 'shop',
  table,
  columns,
  rows,
})

function run(o: Partial<SqlExportOptions>, events: SqlEvent[]): string {
  const w = new SqlWriter(opts(o))
  return events.map((e) => w.write(e)).join('')
}

describe('header and footer', () => {
  it('writes comments, custom comment and self-contained session settings', () => {
    const s = run({ customComment: 'line1\nline2\r\n; DROP TABLE x' }, [header, { type: 'footer' }])
    expect(s).toContain('-- DBLoom SQL dump 1.0.0\n-- Server version: 8.4.13\n-- Generated: 2026-10-27 12:00:00 UTC\n')
    expect(s).toContain('--\n-- line1\n-- line2\n-- ; DROP TABLE x\n')
    expect(s).toContain('SET NAMES utf8mb4;')
    expect(s).toContain("SET time_zone = '+00:00';")
    expect(s).toContain('SET foreign_key_checks = 0;')
    expect(s).toContain('SET unique_checks = 0;')
    expect(s).toContain("SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';")
    expect(s).toContain('SET sql_mode = @OLD_SQL_MODE;')
    expect(s).toContain('SET foreign_key_checks = @OLD_FOREIGN_KEY_CHECKS;')
    // every comment line starts with "-- ": the custom text cannot become a statement
    for (const line of s.split('\n')) if (line.includes('DROP TABLE x')) expect(line.startsWith('-- ')).toBe(true)
  })
  it('without comments and without FK switch', () => {
    const s = run({ comments: false, foreignKeyChecksOff: false }, [header])
    expect(s).not.toContain('--')
    expect(s).not.toContain('foreign_key_checks = 0')
  })
  it('names in comments cannot break out of the line', () => {
    const s = run({}, [header, { type: 'object', kind: 'table', database: 'd', name: 'a\nDROP DATABASE x; --', createText: USERS }])
    expect(s).toContain('-- Table structure for table a DROP DATABASE x; --\n')
  })
})

describe('database events', () => {
  it('create, drop and use only when asked', () => {
    const ev: SqlEvent = { type: 'database', name: 'sh`op', createText: 'CREATE DATABASE `sh``op` /*!40100 DEFAULT CHARACTER SET utf8mb4 */' }
    expect(run({}, [ev])).toBe('')
    const s = run({ createDatabase: true, dropDatabase: true, ifNotExists: true }, [ev])
    expect(s).toContain('DROP DATABASE IF EXISTS `sh``op`;')
    expect(s).toContain('CREATE DATABASE IF NOT EXISTS `sh``op` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;')
    expect(s).toContain('USE `sh``op`;')
  })
  it('falls back to a plain CREATE DATABASE', () => {
    expect(run({ createDatabase: true, comments: false }, [{ type: 'database', name: 'd' }])).toBe('CREATE DATABASE `d`;\nUSE `d`;\n\n')
  })
})

describe('objects', () => {
  const tbl = (createText: string, extra: Partial<Extract<SqlEvent, { type: 'object' }>> = {}): SqlEvent => ({
    type: 'object',
    kind: 'table',
    database: 'shop',
    name: 'users',
    createText,
    ...extra,
  })
  it('emits the server text unchanged by default', () => {
    expect(run({ comments: false }, [tbl(USERS)])).toBe(USERS + ';\n\n')
  })
  it('DROP, IF NOT EXISTS and AUTO_INCREMENT value options', () => {
    const s = run({ comments: false, dropObjects: true, ifNotExists: true, autoIncrementValue: false }, [tbl(USERS)])
    expect(s.startsWith('DROP TABLE IF EXISTS `users`;\nCREATE TABLE IF NOT EXISTS `users` (')).toBe(true)
    expect(s).toContain(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;')
  })
  it('structure only skips data, data only skips structure', () => {
    const ev = [tbl(USERS), rowBatch('users', [['1', 'a']]), { type: 'table-end' } as SqlEvent]
    expect(run({ content: 'structure' }, ev)).not.toContain('INSERT')
    expect(run({ content: 'data' }, ev)).not.toContain('CREATE TABLE')
    expect(run({ content: 'data' }, ev)).toContain('INSERT INTO `users`')
  })
  it('keys go to ALTER TABLE after the data when asked', () => {
    const s = run({ comments: false, keysInCreateTable: false }, [
      { type: 'object', kind: 'table', database: 'shop', name: 'orders', createText: ORDERS },
      rowBatch('orders', [['1', 'x']], [{ name: 'oid', kind: 'int' }, { name: 'note', kind: 'text' }]),
      { type: 'footer' },
    ])
    const create = s.slice(0, s.indexOf(';\n'))
    expect(create).not.toContain('PRIMARY KEY')
    expect(create).not.toContain('KEY `uid`')
    expect(create).toContain('CONSTRAINT `fk_u`')
    expect(create).toContain('  `note` text,\n  CONSTRAINT')
    const alter = s.slice(s.indexOf('ALTER TABLE'))
    expect(alter).toContain('ALTER TABLE `orders`\n  ADD PRIMARY KEY (`oid`),\n  ADD UNIQUE KEY `u` (`note`(20)),\n  ADD KEY `uid` (`uid`);')
    expect(s.indexOf('INSERT')).toBeLessThan(s.indexOf('ALTER TABLE'))
  })
  it('keeps the keys of a table with an AUTO_INCREMENT column in CREATE TABLE', () => {
    const s = run({ comments: false, keysInCreateTable: false }, [tbl(USERS), { type: 'footer' }])
    expect(s).toContain('PRIMARY KEY (`id`)')
    expect(s).not.toContain('ALTER TABLE')
  })
  it('defers cycle foreign keys to ALTER after all data', () => {
    const s = run({ comments: false }, [
      { type: 'object', kind: 'table', database: 'shop', name: 'orders', createText: ORDERS, deferForeignKeysTo: ['users'] },
      rowBatch('orders', [['1', 'x']], [{ name: 'oid', kind: 'int' }, { name: 'note', kind: 'text' }]),
      { type: 'footer' },
    ])
    const create = s.slice(0, s.indexOf(';\n'))
    expect(create).not.toContain('CONSTRAINT')
    expect(create).toContain('  KEY `uid` (`uid`)\n)')
    expect(s).toContain('ALTER TABLE `orders`\n  ADD CONSTRAINT `fk_u` FOREIGN KEY (`uid`) REFERENCES `users` (`id`) ON DELETE CASCADE;')
    expect(s.indexOf('INSERT')).toBeLessThan(s.indexOf('ALTER TABLE'))
  })
  it('wraps triggers and routines in DELIMITER blocks and picks a delimiter the body does not contain', () => {
    const body = 'CREATE DEFINER=`r`@`h` PROCEDURE `p`()\nBEGIN\n  SELECT "a;b" AS x;\nEND'
    const s = run({ comments: false, routines: true, triggers: true, events: true }, [
      { type: 'object', kind: 'procedure', database: 'shop', name: 'p', createText: body },
      { type: 'object', kind: 'trigger', database: 'shop', name: 't', createText: body.replaceAll('"a;b"', () => '"' + '$'.repeat(2) + '"') },
    ])
    expect(s).toContain('DELIMITER $$\n' + body + '$$\nDELIMITER ;\n')
    expect(s).toContain('DELIMITER $$$\n')
    expect(s).toContain('AS x;\nEND' + '$'.repeat(3) + '\nDELIMITER ;')
  })
  it('skips object kinds that are switched off', () => {
    const ev = (kind: 'view' | 'procedure' | 'trigger' | 'event'): SqlEvent => ({ type: 'object', kind, database: 'd', name: 'x', createText: 'CREATE X' })
    expect(run({ views: false }, [ev('view')])).toBe('')
    expect(run({}, [ev('procedure')])).toBe('') // routines default off
    expect(run({}, [ev('event')])).toBe('')
    expect(run({ triggers: false }, [ev('trigger')])).toBe('')
    expect(run({ comments: false }, [ev('view')])).toBe('CREATE X;\n\n')
  })
  it('DROP for routines uses the right keyword', () => {
    const s = run({ comments: false, dropObjects: true, routines: true }, [
      { type: 'object', kind: 'function', database: 'd', name: 'f', createText: 'CREATE FUNCTION f() RETURNS int RETURN 1' },
    ])
    expect(s.startsWith('DROP FUNCTION IF EXISTS `f`;')).toBe(true)
  })
})

describe('row batches', () => {
  it('writes one extended insert with escaped values', () => {
    const s = run({ comments: false, transaction: false }, [rowBatch('users', [['1', "O'Brien"], ['2', null], ['3', '\\']]), { type: 'table-end' }])
    expect(s).toBe("INSERT INTO `users` (`id`,`name`) VALUES (1,'O''Brien'),(2,NULL),(3,'\\\\');\n\n")
  })
  it('splits extended inserts at the byte cap', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [String(i), 'x'.repeat(100)])
    const s = run({ comments: false, transaction: false, extendedInsertBytes: 1024 }, [rowBatch('users', rows.slice(0, 4)), rowBatch('users', rows.slice(4)), { type: 'table-end' }])
    const stmts = s.split('\n').filter((l) => l.startsWith('INSERT'))
    expect(stmts.length).toBeGreaterThan(1)
    for (const st of stmts) expect(Buffer.byteLength(st)).toBeLessThanOrEqual(1024)
    expect(stmts.join('').match(/\(\d+,/g)).toHaveLength(10)
  })
  it('a row bigger than the cap goes alone', () => {
    const s = run({ comments: false, transaction: false, extendedInsertBytes: 1024 }, [
      rowBatch('users', [['1', 'a'], ['2', 'x'.repeat(5000)], ['3', 'b']]),
      { type: 'table-end' },
    ])
    expect(s.split('\n').filter((l) => l.startsWith('INSERT'))).toHaveLength(3)
  })
  it('single-row inserts when extended inserts are off', () => {
    const s = run({ comments: false, transaction: false, extendedInserts: false }, [rowBatch('users', [['1', 'a'], ['2', 'b']]), { type: 'table-end' }])
    expect(s).toBe("INSERT INTO `users` (`id`,`name`) VALUES (1,'a');\nINSERT INTO `users` (`id`,`name`) VALUES (2,'b');\n\n")
  })
  it('statement types', () => {
    expect(run({ statement: 'replace' }, [rowBatch('t', [['1', 'a']]), { type: 'table-end' }])).toContain('REPLACE INTO `t`')
    expect(run({ statement: 'insertIgnore' }, [rowBatch('t', [['1', 'a']]), { type: 'table-end' }])).toContain('INSERT IGNORE INTO `t`')
  })
  it('skips generated columns and writes binary, bit and geometry', () => {
    const c: ColumnInfo[] = [
      { name: 'a', kind: 'int' },
      { name: 'g', kind: 'int', generated: true },
      { name: 'b', kind: 'blob' },
      { name: 'bit', kind: 'bit' },
      { name: 'geo', kind: 'geometry' },
    ]
    const s = run({ comments: false, transaction: false }, [
      rowBatch('t', [['1', '2', Buffer.from([1, 2]), Buffer.from([5]), Buffer.from('00000000', 'hex')]], c),
      { type: 'table-end' },
    ])
    expect(s).toBe("INSERT INTO `t` (`a`,`b`,`bit`,`geo`) VALUES (1,0x0102,b'101',0x00000000);\n\n")
  })
  it('backquotes in names are doubled', () => {
    const s = run({ comments: false, transaction: false }, [rowBatch('we`ird', [['1']], [{ name: 'c`d', kind: 'int' }]), { type: 'table-end' }])
    expect(s).toContain('INSERT INTO `we``ird` (`c``d`) VALUES (1);')
  })
  it('wraps each table data section in a transaction', () => {
    const s = run({ comments: false }, [rowBatch('a', [['1', 'x']]), { type: 'table-end' }, rowBatch('b', [['2', 'y']]), { type: 'footer' }])
    expect(s.match(/START TRANSACTION;/g)).toHaveLength(2)
    expect(s.match(/^COMMIT;/gm)).toHaveLength(2)
    expect(s.indexOf('COMMIT;')).toBeLessThan(s.indexOf('INSERT INTO `b`'))
  })
  it('flushes pending rows when the table changes without table-end', () => {
    const s = run({ comments: false, transaction: false }, [rowBatch('a', [['1', 'x']]), rowBatch('b', [['2', 'y']]), { type: 'footer' }])
    expect(s.indexOf('INSERT INTO `a`')).toBeLessThan(s.indexOf('INSERT INTO `b`'))
    expect(s.match(/INSERT INTO/g)).toHaveLength(2)
  })
  it('is identical for identical input (golden)', () => {
    const ev: SqlEvent[] = [
      header,
      { type: 'database', name: 'shop', createText: 'CREATE DATABASE `shop`' },
      { type: 'object', kind: 'table', database: 'shop', name: 'users', createText: USERS },
      rowBatch('users', [['1', 'a']]),
      { type: 'table-end' },
      { type: 'footer' },
    ]
    const o = { createDatabase: true }
    expect(run(o, ev)).toBe(run(o, ev))
    expect(run(o, ev)).toMatchInlineSnapshot(`
      "-- DBLoom SQL dump 1.0.0
      -- Server version: 8.4.13
      -- Generated: 2026-10-27 12:00:00 UTC

      SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT, @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS, @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION, @OLD_TIME_ZONE=@@TIME_ZONE, @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, @OLD_SQL_MODE=@@SQL_MODE;
      SET NAMES utf8mb4;
      SET time_zone = '+00:00';
      SET unique_checks = 0;
      SET foreign_key_checks = 0;
      SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';

      -- Database shop
      CREATE DATABASE \`shop\`;
      USE \`shop\`;

      -- Table structure for table users
      CREATE TABLE \`users\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`name\` varchar(50) DEFAULT NULL,
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4;

      -- Dumping data for table users
      START TRANSACTION;
      INSERT INTO \`users\` (\`id\`,\`name\`) VALUES (1,'a');
      COMMIT;

      SET sql_mode = @OLD_SQL_MODE;
      SET foreign_key_checks = @OLD_FOREIGN_KEY_CHECKS;
      SET unique_checks = @OLD_UNIQUE_CHECKS;
      SET time_zone = @OLD_TIME_ZONE;
      SET character_set_client = @OLD_CHARACTER_SET_CLIENT;
      SET character_set_results = @OLD_CHARACTER_SET_RESULTS;
      SET collation_connection = @OLD_COLLATION_CONNECTION;
      "
    `)
  })
})

describe('writeSql', () => {
  it('yields non-empty chunks from an async iterable', async () => {
    async function* ev(): AsyncGenerator<SqlEvent> {
      yield header
      yield rowBatch('users', [['1', 'a']])
      yield { type: 'footer' }
    }
    const out: string[] = []
    for await (const c of writeSql(opts(), ev())) out.push(c)
    expect(out.every((c) => c !== '')).toBe(true)
    expect(out.join('')).toContain('INSERT INTO `users`')
  })
})

describe('splitCreateTable and foreign key targets', () => {
  it('splits and finds targets', () => {
    const p = splitCreateTable(ORDERS)
    expect(p?.defs).toHaveLength(7)
    expect(foreignKeyTargets(ORDERS)).toEqual(['users'])
    const qualified = ORDERS.replace('REFERENCES `users`', 'REFERENCES `other`.`we``ird`')
    expect(foreignKeyTargets(qualified)).toEqual(['we`ird'])
  })
  it('returns null for text it does not understand', () => {
    expect(splitCreateTable('CREATE VIEW v AS SELECT 1')).toBeNull()
  })
})

describe('orderByDependency', () => {
  const n = (name: string, ...deps: string[]) => ({ name, deps })
  it('puts referenced tables first, ties by name', () => {
    const r = orderByDependency([n('orders', 'users'), n('users'), n('audit'), n('items', 'orders', 'products'), n('products')])
    expect(r.order).toEqual(['audit', 'products', 'users', 'orders', 'items'])
    expect(r.cycles).toEqual([])
    expect(r.deferred).toEqual({})
  })
  it('is independent of input order', () => {
    const nodes = [n('b', 'a'), n('a'), n('c', 'b'), n('d')]
    const first = orderByDependency(nodes).order
    expect(orderByDependency([...nodes].reverse()).order).toEqual(first)
  })
  it('ignores self references and unknown targets', () => {
    const r = orderByDependency([n('tree', 'tree', 'elsewhere'), n('a')])
    expect(r.order).toEqual(['a', 'tree'])
    expect(r.cycles).toEqual([])
  })
  it('breaks cycles at the smallest name and reports what to defer', () => {
    const r = orderByDependency([n('b', 'a'), n('a', 'b'), n('c', 'a'), n('z')])
    expect(r.order).toEqual(['z', 'a', 'b', 'c'])
    expect(r.deferred).toEqual({ a: ['b'] })
    expect(r.cycles).toEqual([['a', 'b']])
  })
  it('three-node cycle plus an outsider', () => {
    const r = orderByDependency([n('x', 'y'), n('y', 'z'), n('z', 'x'), n('w', 'x')])
    expect(r.cycles).toEqual([['x', 'y', 'z']])
    expect(r.order).toEqual(['x', 'w', 'z', 'y'])
    expect(Object.keys(r.deferred)).toEqual(['x'])
  })
})
