'use client'

import { useEffect, useRef, useState } from 'react'

type Phase = 'ask' | 'running' | 'done' | 'denied'

const RESULT = [
  ['Sofia Reyes', '1 204.50'],
  ['Ada Lindqvist', '988.00'],
  ['Lea Fischer', '861.30'],
  ['Ines Duarte', '640.75'],
  ['Omar Haddad', '512.10'],
] as const

const NOTES = [
  { id: 'scope', top: 28, side: 'left', name: 'It knows one connection', text: 'The panel works inside the connection you are using, with your own rights. Anything the server forbids stays forbidden.' },
  { id: 'schema', top: 150, side: 'right', name: 'It reads the schema first', text: 'describe_tables returns table and column names only, so it can write SQL without seeing your data.' },
  { id: 'pii', top: 238, side: 'left', name: 'Personal data stays home', text: 'Columns an administrator marks, like *.*.email, never reach the AI service. Their values stay in your browser.' },
  { id: 'sql', top: 360, side: 'right', name: 'You read the statement', text: 'Every call waits as the exact SQL that will run, before anything touches your database.' },
  { id: 'approve', top: 470, side: 'left', name: 'Approve or deny', text: 'In manual mode each call needs your click. Writes always ask, even in auto mode.' },
  { id: 'audit', top: 590, side: 'right', name: 'Every step is logged', text: 'Calls, approvals and refusals go to the audit log as SQL in token form, never as values or rows.' },
] as const

export function AssistantPanel() {
  const [active, setActive] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('ask')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  function approve() {
    setPhase('running')
    timer.current = setTimeout(() => setPhase('done'), 900)
  }
  const on = (id: string) => (active === id ? 'hot' : '')

  return (
    <div className="plate">
      <div className="plate-notes left">
        {NOTES.filter((n) => n.side === 'left').map((n) => (
          <button key={n.id} type="button" className={`note ${on(n.id)}`} style={{ top: n.top }} onMouseEnter={() => setActive(n.id)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(n.id)} onBlur={() => setActive(null)}>
            <strong>{n.name}</strong>
            <span>{n.text}</span>
          </button>
        ))}
      </div>

      <div className="panel" data-ui aria-label="The assistant sidebar of DBLoom">
        <div className={`p-head ${on('scope')}`}>
          <b>Assistant</b>
          <span>connection: shop</span>
        </div>
        <div className="p-body">
          <p className="msg you">Which customers spent the most in March?</p>
          <div className={`call ${on('schema')}`}>
            <span>describe_tables</span> orders, customers
          </div>
          <div className={`pii ${on('pii')}`}>customers.email is marked personal and stays hidden.</div>
          <div className={`sql ${on('sql')} ${phase === 'denied' ? 'void' : ''} ${phase === 'running' ? 'run' : ''}`}>
            <code>
              SELECT c.name, SUM(o.total) AS spent
              <br />
              FROM orders o JOIN customers c ON c.id = o.customer_id
              <br />
              WHERE o.created_at &gt;= &apos;2026-03-01&apos;
              <br />
              GROUP BY c.id ORDER BY spent DESC LIMIT 5;
            </code>
          </div>
          {phase === 'ask' && (
            <div className={`actions ${on('approve')}`}>
              <button type="button" onClick={approve}>Approve</button>
              <button type="button" className="ghost" onClick={() => setPhase('denied')}>Deny</button>
            </div>
          )}
          {phase === 'running' && (
            <div className="status pop" role="status">
              <i className="spin" aria-hidden="true" /> Running as you…
            </div>
          )}
          {phase === 'done' && (
            <div className="result pop" role="status">
              <div className="ok">Approved. 5 rows in 12 ms.</div>
              <table>
                <tbody>
                  {RESULT.map(([n, v], i) => (
                    <tr key={n} style={{ animationDelay: `${i * 70}ms` }}>
                      <td>{n}</td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" className="again" onClick={() => setPhase('ask')}>Ask again</button>
            </div>
          )}
          {phase === 'denied' && (
            <div className="result pop" role="status">
              <div className="no">Denied. Nothing was run, nothing changed.</div>
              <button type="button" className="again" onClick={() => setPhase('ask')}>Ask again</button>
            </div>
          )}
        </div>
        <div className={`p-foot ${on('audit')}`}>
          <span>Mode: manual</span>
          <span key={phase} className={phase === 'ask' ? '' : 'pop'}>
            {phase === 'ask' && 'assistant.call logged'}
            {phase === 'running' && 'assistant.call approved'}
            {phase === 'done' && 'assistant.call ok · logged'}
            {phase === 'denied' && 'assistant.call denied · logged'}
          </span>
        </div>
      </div>

      <div className="plate-notes right">
        {NOTES.filter((n) => n.side === 'right').map((n) => (
          <button key={n.id} type="button" className={`note ${on(n.id)}`} style={{ top: n.top }} onMouseEnter={() => setActive(n.id)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(n.id)} onBlur={() => setActive(null)}>
            <strong>{n.name}</strong>
            <span>{n.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
