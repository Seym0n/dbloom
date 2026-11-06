'use client'

import { useEffect, useRef, useState } from 'react'

type Cell = string | number | null
type Query = {
  id: string
  chip: string
  sql: string
  cols: string[]
  rows: Cell[][]
  mark?: { row?: number; col?: number }
  note: string
}

const ORDERS: Cell[][] = [
  [1042, 'Ada Lindqvist', '184.00', 'shipped'],
  [1041, 'Marek Novak', '62.50', 'paid'],
  [1040, 'Sofia Reyes', '311.20', 'shipped'],
  [1039, 'Tomas Berg', '24.90', 'refunded'],
]
const BASE = ['id', 'customer', 'total', 'status']

const QUERIES: Query[] = [
  {
    id: 'top',
    chip: 'Top customers',
    sql: 'SELECT customer, SUM(total) AS spent\nFROM orders\nGROUP BY customer\nORDER BY spent DESC LIMIT 4;',
    cols: ['customer', 'spent'],
    rows: [
      ['Sofia Reyes', '1 204.50'],
      ['Ada Lindqvist', '988.00'],
      ['Lea Fischer', '861.30'],
      ['Ines Duarte', '640.75'],
    ],
    note: '4 rows in 9 ms',
  },
  {
    id: 'ship',
    chip: 'Ship an order',
    sql: "UPDATE orders\nSET status = 'shipped'\nWHERE id = 1041;",
    cols: BASE,
    rows: ORDERS.map((r) => (r[0] === 1041 ? [1041, 'Marek Novak', '62.50', 'shipped'] : r)),
    mark: { row: 1, col: 3 },
    note: '1 row affected',
  },
  {
    id: 'col',
    chip: 'Add a column',
    sql: 'ALTER TABLE orders\nADD COLUMN note VARCHAR(80) NULL;',
    cols: [...BASE, 'note'],
    rows: ORDERS.map((r) => [...r, null]),
    mark: { col: 4 },
    note: 'Table changed, 4 rows kept',
  },
  {
    id: 'count',
    chip: 'Count by status',
    sql: 'SELECT status, COUNT(*) AS orders\nFROM orders\nGROUP BY status;',
    cols: ['status', 'orders'],
    rows: [
      ['shipped', 2],
      ['paid', 1],
      ['refunded', 1],
    ],
    note: '3 rows in 4 ms',
  },
]

function hit(q: Query, ri: number, ci: number) {
  const m = q.mark
  if (!m) return false
  return (m.row === undefined || m.row === ri) && (m.col === undefined || m.col === ci)
}

export function SqlDemo() {
  const [qid, setQid] = useState('top')
  const [typed, setTyped] = useState(QUERIES[0].sql.length)
  const [ran, setRan] = useState(true)
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const q = QUERIES.find((x) => x.id === qid) ?? QUERIES[0]

  useEffect(() => () => clearInterval(timer.current), [])

  function pick(id: string) {
    clearInterval(timer.current)
    const next = QUERIES.find((x) => x.id === id) ?? QUERIES[0]
    setQid(id)
    setRan(false)
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTyped(next.sql.length)
      setRan(true)
      setTick((t) => t + 1)
      return
    }
    let n = 0
    setTyped(0)
    timer.current = setInterval(() => {
      n += 2
      setTyped(n)
      if (n >= next.sql.length) {
        clearInterval(timer.current)
        setTimeout(() => {
          setRan(true)
          setTick((t) => t + 1)
        }, 220)
      }
    }, 16)
  }

  function run() {
    clearInterval(timer.current)
    setTyped(q.sql.length)
    setRan(true)
    setTick((t) => t + 1)
  }

  return (
    <div className="sqld-box" data-ui>
      <div className="sqld-chips" role="group" aria-label="Pick a statement">
        {QUERIES.map((x) => (
          <button key={x.id} type="button" aria-pressed={x.id === qid} onClick={() => pick(x.id)}>
            {x.chip}
          </button>
        ))}
      </div>
      <div className="sqld-editor">
        <pre aria-label="SQL">
          <code>
            {q.sql.slice(0, typed)}
            {typed < q.sql.length && <span className="caret" />}
          </code>
        </pre>
        <button type="button" className="sqld-run" onClick={run} disabled={ran && typed >= q.sql.length}>
          Run
        </button>
      </div>
      <div className="sqld-out" aria-live="polite">
        {ran ? (
          <>
            <table key={`${qid}-${tick}`}>
              <thead>
                <tr>
                  {q.cols.map((c, ci) => (
                    <th key={c} className={q.mark?.col === ci ? 'mk' : ''}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.rows.map((r, ri) => (
                  <tr key={ri} style={{ animationDelay: `${ri * 70}ms` }}>
                    {r.map((v, ci) => (
                      <td key={ci} className={hit(q, ri, ci) ? 'mk' : ''}>
                        {v === null ? <i>NULL</i> : v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sqld-note">{q.note}</p>
          </>
        ) : (
          <p className="sqld-note">Typing…</p>
        )}
      </div>
    </div>
  )
}
