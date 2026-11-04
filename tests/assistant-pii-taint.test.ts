import { beforeAll, describe, expect, test } from 'vitest'
import { analyzeStatement, type AnalyzeContext, type SchemaLookup, type Taint } from '~/server/assistant/pii/taint'
import { compileRules, parseRuleList } from '~/server/assistant/pii/rules'
import { initParser } from '~/server/sql/parser'

// SPEC/34 FR-AST-008 (taint classes) and FR-AST-009 (inference guard), table driven.

const SCHEMA: Record<string, { columns: [string, string][]; view?: boolean }> = {
  'shop.customers': {
    columns: [['id', 'int'], ['email', 'varchar(120)'], ['first', 'varchar(40)'], ['last', 'varchar(40)'], ['city', 'varchar(40)'], ['salary', 'decimal(10,2)']],
  },
  'shop.orders': { columns: [['id', 'int'], ['customer_id', 'int'], ['total', 'decimal(10,2)'], ['note', 'text']] },
  'shop.v_customers': { columns: [['id', 'int'], ['mail', 'varchar(120)']], view: true },
}
const schema: SchemaLookup = (db, table) => {
  const hit = SCHEMA[`${(db ?? 'shop').toLowerCase()}.${table.toLowerCase()}`]
  return hit ? { columns: hit.columns.map(([name, type]) => ({ name, type })), view: hit.view === true } : undefined
}
const RULES = compileRules(parseRuleList('shop.customers.email, shop.customers.first, shop.customers.last, shop.customers.salary, *.*.mail').rules)
const ISSUED = new Set(['<email:abcd:1>', '<email:abcd:2>'])

const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  defaultDb: 'shop',
  rules: RULES,
  schema,
  isIssuedToken: (s) => ISSUED.has(s),
  ...over,
})
const taints = (sql: string, over: Partial<AnalyzeContext> = {}): Taint[] => {
  const a = analyzeStatement(sql, ctx(over))
  if (a.kind !== 'query') throw new Error(`${sql}: ${JSON.stringify(a)}`)
  return a.outputs.map((o) => o.taint)
}
const names = (sql: string): string[] => {
  const a = analyzeStatement(sql, ctx())
  if (a.kind !== 'query') throw new Error(sql)
  return a.outputs.map((o) => o.name)
}
const violations = (sql: string, over: Partial<AnalyzeContext> = {}): string[] => {
  const a = analyzeStatement(sql, ctx(over))
  if (a.kind === 'unsupported') throw new Error(`${sql}: ${a.reason}`)
  return a.violations.map((v) => v.detail)
}

beforeAll(async () => {
  await initParser()
})

describe('taint classes of output columns', () => {
  const cases: [string, string, Taint[]][] = [
    ['plain columns', 'SELECT id, email FROM customers', ['clean', 'pii']],
    ['alias', 'SELECT email AS e FROM customers', ['pii']],
    ['concat', "SELECT CONCAT(first, ' ', last) AS n FROM customers", ['pii']],
    ['case expression', 'SELECT CASE WHEN email IS NULL THEN 1 ELSE 0 END AS x FROM customers', ['pii']],
    ['arithmetic on a PII number', 'SELECT salary * 12 AS yearly FROM customers', ['pii']],
    ['wildcard expands from the schema', 'SELECT * FROM customers', ['clean', 'pii', 'pii', 'pii', 'clean', 'pii']],
    ['qualified wildcard', 'SELECT c.*, o.id FROM customers c JOIN orders o ON o.customer_id = c.id', ['clean', 'pii', 'pii', 'pii', 'clean', 'pii', 'clean']],
    ['join, qualified', 'SELECT o.total, c.email FROM orders o JOIN customers c ON c.id = o.customer_id', ['clean', 'pii']],
    ['db qualified table', 'SELECT shop.customers.email FROM shop.customers', ['pii']],
    ['unqualified column in a join', 'SELECT email, total FROM customers c JOIN orders o ON o.customer_id = c.id', ['pii', 'clean']],
    ['scalar subquery', 'SELECT (SELECT email FROM customers c WHERE c.id = o.customer_id) AS m FROM orders o', ['pii']],
    ['derived table', 'SELECT m FROM (SELECT email AS m FROM customers) t', ['pii']],
    ['derived table renamed by alias columns', 'SELECT x, y FROM (SELECT email, id FROM customers) t (x, y)', ['pii', 'clean']],
    ['CTE', 'WITH w AS (SELECT email AS m, id FROM customers) SELECT * FROM w', ['pii', 'clean']],
    ['union takes the worst of each position', 'SELECT city FROM customers UNION SELECT email FROM customers', ['pii']],
    ['union of different widths', 'SELECT id, city FROM customers UNION SELECT id FROM orders', ['unknown', 'unknown']],
    ['view: nothing can be said but a marked name', 'SELECT * FROM v_customers', ['unknown', 'pii']],
    ['COUNT is clean even over PII', 'SELECT COUNT(*), COUNT(DISTINCT email), COUNT(salary) FROM customers', ['clean', 'clean', 'clean']],
    ['other aggregates over PII are PII', 'SELECT MAX(salary), AVG(salary), GROUP_CONCAT(email) FROM customers', ['pii', 'pii', 'pii']],
    ['aggregate over clean columns', 'SELECT SUM(total) FROM orders', ['clean']],
    ['window over clean', 'SELECT ROW_NUMBER() OVER (ORDER BY id) FROM customers', ['clean']],
    ['window sum over PII', 'SELECT SUM(salary) OVER () FROM customers', ['pii']],
    ['literals', "SELECT 1, 'x', NULL", ['clean', 'clean', 'clean']],
    ['correlated subquery in WHERE leaves outputs clean', 'SELECT id FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id)', ['clean']],
    ['column that does not resolve', 'SELECT nosuch FROM customers', ['unknown']],
    ['VALUES the parser does not read stay unknown', "SELECT * FROM (VALUES ROW(1, 'a')) AS t", ['unknown']],
  ]
  test.each(cases)('%s', (_n, sql, expected) => {
    expect(taints(sql)).toEqual(expected)
  })

  test('a table with no schema entry is read by name against the markings', () => {
    expect(taints('SELECT email, city FROM customers', { schema: undefined })).toEqual(['pii', 'clean'])
    expect(taints('SELECT email FROM elsewhere.people')).toEqual(['clean']) // no marking names that database
  })

  test('output names: alias, column, or a placeholder', () => {
    expect(names('SELECT email AS e, id, c.city, 1 + 1 FROM customers c')).toEqual(['e', 'id', 'city', 'col4'])
  })

  test('without markings and without acknowledgement text-like columns are unknown, numbers are not', () => {
    const open = { rules: compileRules([]), unconfigured: true }
    expect(taints('SELECT id, email, city, salary FROM customers', open)).toEqual(['clean', 'unknown', 'unknown', 'clean'])
    expect(taints('SELECT email FROM customers', { ...open, schema: undefined })).toEqual(['unknown'])
    // a marking still wins over "unknown"
    expect(taints('SELECT email FROM customers', { ...open, rules: RULES })).toEqual(['pii'])
  })

  test('with no markings at all and an acknowledgement nothing is PII', () => {
    expect(taints('SELECT email, city FROM customers', { rules: compileRules([]) })).toEqual(['clean', 'clean'])
  })

  test('what is not a plain query is unsupported, never clean', () => {
    for (const sql of ['SELECT FROM WHERE', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'DESCRIBE customers', 'DELETE FROM customers WHERE id = 1']) {
      const a = analyzeStatement(sql, ctx())
      expect(a.kind, sql).toBe('unsupported')
    }
  })

  test('a statement of absurd size is unsupported rather than slow', () => {
    const wide = `SELECT ${Array.from({ length: 6000 }, (_, i) => `id + ${i}`).join(', ')} FROM customers`
    expect(['query', 'unsupported']).toContain(analyzeStatement(wide, ctx()).kind)
  })
})

describe('inference guard', () => {
  const refused: [string, string][] = [
    ['LIKE', "SELECT id FROM customers WHERE email LIKE 'a%'"],
    ['NOT LIKE through NOT', "SELECT id FROM customers WHERE NOT (email LIKE 'a%')"],
    ['REGEXP', "SELECT id FROM customers WHERE email REGEXP '^a'"],
    ['range', 'SELECT id FROM customers WHERE salary > 5000'],
    ['BETWEEN', 'SELECT id FROM customers WHERE salary BETWEEN 1 AND 9'],
    ['SUBSTR in an equality', "SELECT id FROM customers WHERE SUBSTR(email, 1, 1) = 'a'"],
    ['LEFT, ASCII, ORD, HEX, FOO', "SELECT id FROM customers WHERE ASCII(LEFT(email, 1)) = 97 OR ORD(email) = 1 OR HEX(email) = 'A' OR FOO(email) = 1"],
    ['MAX in HAVING', 'SELECT city FROM customers GROUP BY city HAVING MAX(salary) > 5'],
    ['MIN in HAVING', "SELECT city FROM customers GROUP BY city HAVING MIN(email) = 'a'"],
    ['a guessed literal is not a token', "SELECT id FROM customers WHERE email = 'guess@x.example'"],
    ['a token of another conversation', "SELECT id FROM customers WHERE email = '<email:zzzz:1>'"],
    ['IN with plain values', "SELECT id FROM customers WHERE email IN ('a@x.example', 'b@x.example')"],
    ['function in a join condition', 'SELECT 1 FROM customers c JOIN orders o ON LOWER(c.email) = o.note'],
    ['ORDER BY an expression over PII', 'SELECT id FROM customers ORDER BY LENGTH(email)'],
    ['GROUP BY an expression over PII', 'SELECT COUNT(*) FROM customers GROUP BY LEFT(email, 1)'],
    ['window ordered by an expression over PII', 'SELECT SUM(id) OVER (ORDER BY LOWER(email)) FROM customers'],
    ['inside a subquery', "SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE email LIKE 'a%')"],
    ['inside a derived table', "SELECT n FROM (SELECT COUNT(*) AS n FROM customers WHERE email LIKE 'a%') t"],
    ['inside a CTE', "WITH w AS (SELECT id FROM customers WHERE salary > 1) SELECT id FROM w"],
    ['inside an EXISTS', "SELECT id FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.email LIKE 'a%')"],
    ['bare PII column as a condition', 'SELECT id FROM customers WHERE salary'],
    ['equality with an expression', 'SELECT id FROM customers WHERE email = CONCAT(city, 1)'],
    ['write with LIKE in WHERE', "UPDATE customers SET city = 'x' WHERE email LIKE 'a%'"],
    ['insert select with LIKE', "INSERT INTO orders (note) SELECT email FROM customers WHERE email LIKE 'a%'"],
  ]
  test.each(refused)('refused: %s', (_n, sql) => {
    expect(violations(sql).length, sql).toBeGreaterThan(0)
  })

  const allowed: [string, string][] = [
    ['equality with an issued token', "SELECT id FROM customers WHERE email = '<email:abcd:1>'"],
    ['token on the left', "SELECT id FROM customers WHERE '<email:abcd:1>' = email"],
    ['IN with issued tokens', "SELECT id FROM customers WHERE email IN ('<email:abcd:1>', '<email:abcd:2>')"],
    ['IS NULL and IS NOT NULL', 'SELECT id FROM customers WHERE email IS NULL OR salary IS NOT NULL'],
    ['a clean column compared as usual', "SELECT id FROM customers WHERE city = 'Paris' AND id > 3"],
    ['column equals column', 'SELECT c.id FROM customers c JOIN orders o ON c.email = o.note'],
    ['ORDER BY and GROUP BY a bare PII column', 'SELECT email, COUNT(*) FROM customers GROUP BY email ORDER BY email'],
    ['ORDER BY an ordinal', 'SELECT email FROM customers ORDER BY 1'],
    ['ORDER BY an alias of PII', 'SELECT email AS e FROM customers ORDER BY e'],
    ['DISTINCT and COUNT(DISTINCT) over PII', 'SELECT COUNT(DISTINCT email) FROM customers'],
    ['HAVING with COUNT', 'SELECT email FROM customers GROUP BY email HAVING COUNT(*) > 1'],
    ['an expression over PII in the select list is tainted, not refused', "SELECT UPPER(email), CONCAT(first, last) FROM customers"],
    ['MAX over PII in the select list', 'SELECT MAX(salary) FROM customers'],
    ['IN subquery on a bare PII column', 'SELECT id FROM orders WHERE note IN (SELECT email FROM customers)'],
    ['write by a token', "UPDATE customers SET city = 'x' WHERE email = '<email:abcd:1>'"],
    ['write by key', 'UPDATE customers SET email = NULL WHERE id = 1'],
    ['insert with a token value', "INSERT INTO customers (id, email) VALUES (9, '<email:abcd:1>')"],
    ['clean tables are not restricted at all', "SELECT id FROM orders WHERE note LIKE '%gift%' AND total > 5 ORDER BY LENGTH(note)"],
  ]
  test.each(allowed)('allowed: %s', (_n, sql) => {
    expect(violations(sql), sql).toEqual([])
  })

  test('a violation carries a readable reason and repeats are listed once', () => {
    const v = violations("SELECT id FROM customers WHERE email LIKE 'a%' OR email LIKE 'b%'")
    expect(v.length).toBeGreaterThan(0)
    expect(new Set(v).size).toBe(v.length)
    expect(v[0]).toMatch(/PII/)
  })

  test('writes are reported as writes', () => {
    expect(analyzeStatement("UPDATE customers SET city = 'x' WHERE id = 1", ctx()).kind).toBe('write')
    expect(analyzeStatement("INSERT INTO orders (id) VALUES (1)", ctx()).kind).toBe('write')
  })
})
