'use client'

import { useState } from 'react'

type Engine = 'mysql' | 'mariadb'

const ROWS = [
  { id: 1042, customer: 'Ada Lindqvist', total: '184.00', status: 'shipped' },
  { id: 1041, customer: 'Marek Novak', total: '62.50', status: 'paid' },
  { id: 1040, customer: 'Sofia Reyes', total: '311.20', status: 'shipped' },
  { id: 1039, customer: 'Tomas Berg', total: '24.90', status: 'refunded' },
  { id: 1038, customer: 'Ines Duarte', total: '97.00', status: 'paid' },
  { id: 1037, customer: 'Yuki Tanaka', total: '148.75', status: 'shipped' },
  { id: 1036, customer: 'Omar Haddad', total: '55.00', status: 'paid' },
  { id: 1035, customer: 'Lea Fischer', total: '420.10', status: 'shipped' },
]

export function HeroDemo() {
  const [engine, setEngine] = useState<Engine>('mysql')
  const [readOnly, setReadOnly] = useState(false)
  const [limit, setLimit] = useState(5)
  const [note, setNote] = useState('')

  const version = engine === 'mysql' ? 'MySQL 8.4' : 'MariaDB 10.11'
  const rows = ROWS.slice(0, limit)

  function edit(id: number) {
    if (readOnly) setNote(`Refused: this session is read-only (order ${id} unchanged).`)
    else setNote(`Order ${id} opened for editing.`)
  }

  return (
    <div className="hero-demo">
      <div className="chips" role="group" aria-label="Try the controls">
        <div className="chip" data-ui>
          <span className="chip-label">Server</span>
          <span className="seg" role="radiogroup" aria-label="Server">
            <button type="button" role="radio" aria-checked={engine === 'mysql'} onClick={() => setEngine('mysql')}>MySQL 8.4</button>
            <button type="button" role="radio" aria-checked={engine === 'mariadb'} onClick={() => setEngine('mariadb')}>MariaDB 10.11</button>
          </span>
        </div>
        <div className="chip" data-ui>
          <span className="chip-label">Rows per page</span>
          <input
            type="range"
            min={3}
            max={8}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            aria-label="Rows per page"
          />
          <output>{limit}</output>
        </div>
        <div className="chip" data-ui>
          <span className="chip-label">Read-only</span>
          <button
            type="button"
            role="switch"
            aria-checked={readOnly}
            className="switch"
            onClick={() => {
              setReadOnly(!readOnly)
              setNote('')
            }}
          >
            <span />
          </button>
          <output>{readOnly ? 'on' : 'off'}</output>
        </div>
      </div>

      <div className="browser" data-ui>
        <div className="browser-bar">
          <span className="crumb">
            <b>shop</b> / orders
          </span>
          <span className="tag">{version}</span>
          {readOnly && <span className="tag tag-lock">read-only</span>}
        </div>
        <code className="browser-sql">SELECT * FROM `orders` ORDER BY `id` DESC LIMIT {limit};</code>
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>customer</th>
              <th className="num">total</th>
              <th>status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="num">{r.id}</td>
                <td>{r.customer}</td>
                <td className="num">{r.total}</td>
                <td>{r.status}</td>
                <td className="act">
                  <button type="button" onClick={() => edit(r.id)} className={readOnly ? 'locked' : ''}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="browser-foot" aria-live="polite">
          {note || `Showing ${rows.length} of 1 042 rows`}
        </div>
      </div>
    </div>
  )
}
