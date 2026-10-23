import type { QueryClient } from '@tanstack/react-query'
import type { PreviewInput } from '~/server/structure/types'

/** Query keys the structure screens own or share with the grid and the sidebar. */
export const keys = {
  databases: ['databases'] as const,
  tables: (db: string) => ['tables', db] as const,
  rows: (db: string, table?: string) =>
    table ? (['rows', db, table] as const) : (['rows', db] as const),
  definition: (db: string, table: string) => ['structure', 'definition', db, table] as const,
  lists: ['structure', 'lists'] as const,
}

/** The database and table an input touches, for cache invalidation and tab fix-ups (FR-STR-014). */
export function touched(input: PreviewInput): { db?: string; table?: string; gone?: boolean } {
  switch (input.action) {
    case 'createDatabase':
      return { db: input.name }
    case 'dropDatabase':
      return { db: input.name, gone: true }
    case 'createTable':
      return { db: input.table.db, table: input.table.name }
    case 'alterTable':
      return { db: input.db, table: input.table }
    case 'renameTable':
      return { db: input.db, table: input.table, gone: true }
    case 'dropTable':
      return { db: input.db, table: input.table, gone: true }
    case 'truncateTable':
      return { db: input.db, table: input.table }
  }
}

/**
 * Refreshes what a structure change makes stale: the database list, the table list of the affected
 * databases, and the rows and definition of the affected table. Objects that no longer exist are
 * removed from the cache instead of refetched.
 */
export async function refreshAfterStructure(
  client: QueryClient,
  input: PreviewInput,
): Promise<void> {
  const { db, table, gone } = touched(input)
  const work: Promise<unknown>[] = [client.invalidateQueries({ queryKey: keys.databases })]
  if (input.action === 'dropDatabase' && db) {
    client.removeQueries({ queryKey: keys.tables(db) })
    client.removeQueries({ queryKey: keys.rows(db) })
    client.removeQueries({
      predicate: (q) =>
        q.queryKey[0] === 'structure' && q.queryKey[1] === 'definition' && q.queryKey[2] === db,
    })
  } else if (db) {
    work.push(client.invalidateQueries({ queryKey: keys.tables(db) }))
    if (input.action === 'renameTable' && input.newDb) {
      work.push(client.invalidateQueries({ queryKey: keys.tables(input.newDb) }))
    }
    if (table && gone) {
      client.removeQueries({ queryKey: keys.rows(db, table) })
      client.removeQueries({ queryKey: keys.definition(db, table) })
    } else if (table) {
      work.push(client.invalidateQueries({ queryKey: keys.rows(db, table) }))
      work.push(client.invalidateQueries({ queryKey: keys.definition(db, table) }))
    }
  }
  await Promise.all(work)
}
