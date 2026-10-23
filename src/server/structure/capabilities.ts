import type { Capabilities, CapabilityKey, Product, ServerInfo } from './types'

/**
 * Capability strategies per product (spec 5.4, ARCH-TGT-002). Minimums are MySQL 8.4 and MariaDB 10.11
 * (ARCH-TGT-003), so the version only matters for display; there are no branches for older servers.
 *
 * Cells that the spec marked "verify" were determined by experiment on 2026-10-23 against
 * mysql:8.4.13 (port 33064) and mariadb:10.11.19 (port 33061):
 *
 * | Key                      | MySQL 8.4 | MariaDB 10.11 | Experiment                                                  |
 * |--------------------------|-----------|---------------|-------------------------------------------------------------|
 * | check-constraint         | yes       | yes           | ADD CONSTRAINT x CHECK (..) works on both                   |
 * | check-enforcement-toggle | yes       | NO            | ALTER CHECK x NOT ENFORCED: MySQL ok, MariaDB syntax error  |
 * | index-hide               | yes       | yes           | MySQL: ALTER INDEX i INVISIBLE|VISIBLE (IGNORED = error);   |
 * |                          |           |               | MariaDB: ALTER INDEX i IGNORED|NOT IGNORED (INVISIBLE = err) |
 * | generated-column         | yes       | yes           | GENERATED ALWAYS AS (e) VIRTUAL|STORED works on both;       |
 * |                          |           |               | PERSISTENT only on MariaDB, so the builder emits STORED     |
 * | column-invisible         | yes       | yes           | `x INT INVISIBLE` works on both                             |
 * | type-uuid                | NO        | yes           | `UUID` column: MySQL syntax error                           |
 * | type-inet6               | NO        | yes           | `INET6` column: MySQL syntax error                          |
 * | type-json                | yes       | yes           | MariaDB: alias for LONGTEXT utf8mb4_bin with CHECK(json_valid)|
 * | compressed-column        | NO        | yes           | `TEXT COMPRESSED`: MySQL syntax error                       |
 * | rename-column            | yes       | yes           | ALTER TABLE t RENAME COLUMN a TO b works on both            |
 *
 * Further verified syntax used by the builder: `DROP CONSTRAINT name` drops a CHECK on both products
 * (MySQL also accepts `DROP CHECK`, MariaDB does not).
 */
export type CapabilityStrategy = {
  product: Product
  capabilities: Capabilities
}

const MYSQL_84: Capabilities = {
  'check-constraint': true,
  'check-enforcement-toggle': true,
  'index-hide': true,
  'generated-column': true,
  'column-invisible': true,
  'type-uuid': false,
  'type-inet6': false,
  'type-json': true,
  'compressed-column': false,
  'rename-column': true,
}

const MARIADB_1011: Capabilities = {
  'check-constraint': true,
  'check-enforcement-toggle': false,
  'index-hide': true,
  'generated-column': true,
  'column-invisible': true,
  'type-uuid': true,
  'type-inet6': true,
  'type-json': true,
  'compressed-column': true,
  'rename-column': true,
}

const STRATEGIES: Record<Product, CapabilityStrategy> = {
  mysql: { product: 'mysql', capabilities: MYSQL_84 },
  mariadb: { product: 'mariadb', capabilities: MARIADB_1011 },
}

export function strategyFor(product: Product): CapabilityStrategy {
  return STRATEGIES[product]
}

/** A copy, so callers cannot mutate the shared tables. */
export function capabilitiesFor(server: ServerInfo): Capabilities {
  return { ...strategyFor(server.product).capabilities }
}

/**
 * Maps the startup probe (`SELECT VERSION(), @@version_comment`) to a product and a plain version.
 * "10.11.19-MariaDB-ubu2204" -> mariadb 10.11.19; "5.5.5-10.11.19-MariaDB" (replication prefix) too;
 * "8.4.13" -> mysql 8.4.13. Everything that does not say MariaDB is treated as MySQL.
 */
export function parseServerInfo(version: string, versionComment: string): ServerInfo {
  const product: Product =
    /mariadb/i.test(version) || /mariadb/i.test(versionComment) ? 'mariadb' : 'mysql'
  let v = version.trim()
  if (product === 'mariadb') v = v.replace(/^5\.5\.5-/, '')
  const m = /^\d+(?:\.\d+){0,2}/.exec(v)
  return { product, version: m ? m[0] : v }
}

export type { Capabilities, CapabilityKey }
