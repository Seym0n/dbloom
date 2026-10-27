/**
 * Helpers for the round-trip checks of FR-IO-027 and SCN-063: run a dump with the real command line client of the
 * test container, and compare two databases (SHOW CREATE of every object modulo AUTO_INCREMENT, row checksums).
 * Package D can reuse them to compare an import made by DBLoom with the source database.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { Pool, RowDataPacket } from 'mysql2/promise'

export const PRODUCTS = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql' as const, client: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb' as const, client: 'mariadb' },
]

/** Name of the container that publishes the port, or null when docker (or the container) is not there. */
export function containerOf(port: number): string | null {
  try {
    const r = spawnSync('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'], { encoding: 'utf8' })
    const name = r.stdout?.split(/\r?\n/)[0]?.trim()
    return r.status === 0 && name ? name : null
  } catch {
    return null
  }
}

/** Runs SQL text through the container's client (handles DELIMITER); rejects with the client's message. */
export function runDump(container: string, client: string, db: string, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-i', container, client, '-uroot', '-proot', '--default-character-set=utf8mb4', db], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let err = ''
    p.stderr.on('data', (d: Buffer) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`client exited ${code}: ${err.replace(/^.*Using a password.*$/m, '').slice(0, 2000)}`))))
    p.stdin.on('error', () => undefined)
    p.stdin.end(sql)
  })
}

const rows = async (pool: Pool, sql: string, params: unknown[] = []) =>
  (await pool.query<RowDataPacket[]>(sql, params))[0]

const q = (n: string) => '`' + n.replaceAll('`', '``') + '`'

/** SHOW CREATE text of every table and view, AUTO_INCREMENT and the definer left out, keyed by name. */
export async function createStatements(pool: Pool, db: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const objects = await rows(pool, 'SELECT TABLE_NAME AS n, TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1', [db])
  for (const o of objects) {
    const isView = String(o.t) === 'VIEW'
    const r = (await rows(pool, `SHOW CREATE ${isView ? 'VIEW' : 'TABLE'} ${q(db)}.${q(String(o.n))}`))[0] as RowDataPacket
    const text = String(r[isView ? 'Create View' : 'Create Table'])
    out[String(o.n)] = text
      .replace(/ AUTO_INCREMENT=\d+/, '')
      // MySQL shows `CHARACTER SET x COLLATE y` for a column whose COLLATE was written out, `COLLATE y` otherwise: same column
      .replace(/ CHARACTER SET \w+ COLLATE /g, ' COLLATE ')
      .replace(new RegExp('`' + db.replaceAll('$', '\\$') + '`\\.', 'g'), '`<db>`.')
  }
  return out
}

/** Names of routines, triggers and events (they must exist after a restore). */
export async function programNames(pool: Pool, db: string): Promise<string[]> {
  const out: string[] = []
  for (const r of await rows(pool, 'SELECT ROUTINE_TYPE AS k, ROUTINE_NAME AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [db]))
    out.push(`${r.k} ${r.n}`)
  for (const r of await rows(pool, 'SELECT TRIGGER_NAME AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [db])) out.push(`TRIGGER ${r.n}`)
  for (const r of await rows(pool, 'SELECT EVENT_NAME AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?', [db])) out.push(`EVENT ${r.n}`)
  return out.sort()
}

/** `CHECKSUM TABLE` of every base table (same product only: the value depends on the engine's row format). */
export async function tableChecksums(pool: Pool, db: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const tables = await rows(pool, "SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1", [db])
  for (const t of tables) {
    const r = (await rows(pool, `CHECKSUM TABLE ${q(db)}.${q(String(t.n))}`))[0] as RowDataPacket
    out[String(t.n)] = String(r.Checksum)
  }
  return out
}

export async function rowCounts(pool: Pool, db: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const tables = await rows(pool, "SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1", [db])
  for (const t of tables) out[String(t.n)] = Number((await rows(pool, `SELECT COUNT(*) AS c FROM ${q(db)}.${q(String(t.n))}`))[0]!.c)
  return out
}

export type DatabaseDiff = { kind: 'create' | 'checksum' | 'count' | 'program' | 'missing'; object: string; a?: string; b?: string }

/** Differences between two databases; empty means the round trip is identical (FR-IO-027). */
export async function compareDatabases(
  pool: Pool,
  a: string,
  b: string,
  o: { checksums?: boolean; programs?: boolean } = {},
): Promise<DatabaseDiff[]> {
  const diffs: DatabaseDiff[] = []
  const [ca, cb] = [await createStatements(pool, a), await createStatements(pool, b)]
  for (const name of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
    if (!(name in ca) || !(name in cb)) diffs.push({ kind: 'missing', object: name })
    else if (ca[name] !== cb[name]) diffs.push({ kind: 'create', object: name, a: ca[name], b: cb[name] })
  }
  const [na, nb] = [await rowCounts(pool, a), await rowCounts(pool, b)]
  for (const name of Object.keys(na)) if (na[name] !== nb[name]) diffs.push({ kind: 'count', object: name, a: String(na[name]), b: String(nb[name]) })
  if (o.checksums !== false) {
    const [sa, sb] = [await tableChecksums(pool, a), await tableChecksums(pool, b)]
    for (const name of Object.keys(sa)) if (sa[name] !== sb[name]) diffs.push({ kind: 'checksum', object: name, a: sa[name], b: sb[name] })
  }
  if (o.programs !== false) {
    const [pa, pb] = [await programNames(pool, a), await programNames(pool, b)]
    if (pa.join('|') !== pb.join('|')) diffs.push({ kind: 'program', object: 'programs', a: pa.join(), b: pb.join() })
  }
  return diffs
}

/** Dump tool of the container's product (the mariadb image names it `mariadb-dump`). */
export const dumpTool = (client: string) => (client === 'mariadb' ? 'mariadb-dump' : 'mysqldump')

/** Runs the container's dump tool for one database and returns the bytes it wrote (FR-IO-027: client dump into DBLoom import). */
export function clientDump(container: string, client: string, db: string, args: string[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'docker',
      ['exec', container, dumpTool(client), '-uroot', '-proot', '--default-character-set=utf8mb4', '--routines', '--events', '--triggers', '--single-transaction', ...args, db],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', (d: Buffer) => out.push(d))
    p.stderr.on('data', (d: Buffer) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`dump exited ${code}: ${err.slice(0, 2000)}`))))
  })
}
