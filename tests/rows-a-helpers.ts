import type { RowColumn, RowTable, TypeKind } from '../src/server/rows/types'

const BASE: Record<TypeKind, string> = {
  int: 'int',
  decimal: 'decimal',
  float: 'double',
  bit: 'bit',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  timestamp: 'timestamp',
  year: 'year',
  char: 'varchar',
  text: 'text',
  enum: 'enum',
  set: 'set',
  binary: 'varbinary',
  blob: 'blob',
  json: 'json',
  geometry: 'geometry',
  uuid: 'uuid',
  inet6: 'inet6',
  unknown: 'weird',
}

export function col(name: string, kind: TypeKind, o: Partial<RowColumn> = {}): RowColumn {
  const baseType = o.baseType ?? BASE[kind]
  return {
    name,
    ordinal: 1,
    kind,
    baseType,
    fullType: baseType,
    nullable: false,
    default: { kind: 'none' },
    autoIncrement: false,
    invisible: false,
    comment: '',
    ...o,
  }
}

export function tbl(columns: RowColumn[], o: Partial<RowTable> = {}): RowTable {
  return {
    db: 'shop',
    table: 'item',
    kind: 'table',
    engine: 'InnoDB',
    transactional: true,
    columns: columns.map((c, i) => ({ ...c, ordinal: i + 1 })),
    uniqueKeys: [],
    outgoing: [],
    incoming: [],
    estimatedRows: null,
    ...o,
  }
}

export const ALL_KINDS = Object.keys(BASE) as TypeKind[]
