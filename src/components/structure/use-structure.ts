import { useQuery } from '@tanstack/react-query'
import { getStructureLists, getTableDefinition } from '~/server/structure.functions'
import type { TableDefinition } from '~/server/structure/types'
import { keys } from './invalidate'

/** Engines, character sets, collations and the capability set of the connected server. */
export function useStructureLists() {
  return useQuery({
    queryKey: keys.lists,
    queryFn: () => getStructureLists(),
    staleTime: 5 * 60_000,
  })
}

/**
 * Column names of another table, for the foreign-key editor. The frozen server functions have no
 * catalog reader for it, so this reads one row page and takes the column list from it.
 */
export function useColumnNames(db: string, table: string) {
  return useQuery({
    queryKey: ['structure', 'columns', db, table],
    enabled: db !== '' && table !== '',
    queryFn: async () =>
      (await getTableDefinition({ data: { db, table } })).def.columns.map((c) => c.name),
  })
}

/**
 * Current definition of an existing table, for the alter designer.
 * GAP: the frozen contracts have no server function that returns a `TableDefinition` (package C only
 * delivers preview, execute and the lists). Replace the body with that call when it exists; nothing else
 * in the designer changes.
 */
export async function fetchTableDefinition(db: string, table: string): Promise<TableDefinition> {
  return (await getTableDefinition({ data: { db, table } })).def
}

export function useTableDefinition(db: string, table: string | undefined) {
  return useQuery({
    queryKey: keys.definition(db, table ?? ''),
    enabled: table !== undefined,
    queryFn: () => fetchTableDefinition(db, table as string),
    retry: false,
    staleTime: 0,
  })
}
