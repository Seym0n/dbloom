import type { ReactNode } from 'react'
import { t } from '~/i18n'
import { parseMarkdown, type Inline } from '~/lib/assistant/markdown'

/**
 * Renders the safe Markdown tree (SPEC/34 FR-AST-014). Strings go through React, so model text is never HTML. A link shows
 * its address in the tooltip, opens only on click, in a new tab with `noopener noreferrer`, and never loads anything.
 */
function InlineView({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v
      case 'bold':
        return <strong key={i}>{<InlineView nodes={n.v} />}</strong>
      case 'italic':
        return <em key={i}>{<InlineView nodes={n.v} />}</em>
      case 'code':
        return (
          <code key={i} className="rounded-[4px] bg-raised px-1 py-0.5 font-mono text-[0.85em]">
            {n.v}
          </code>
        )
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" title={n.href} className="underline">
            {n.v}
          </a>
        )
      case 'token':
        return (
          <span key={i} title={t('asst.hiddenHint')} className="rounded-[4px] border border-border bg-raised px-1 py-0.5 font-mono text-[0.8em] text-muted">
            {t('asst.hidden')}
            <span className="sr-only">: {n.v}</span>
          </span>
        )
    }
  })
}

export function RichText({ text }: { text: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className="flex flex-col gap-2 break-words text-sm leading-relaxed">
      {blocks.map((b, i) => {
        if (b.t === 'code')
          return (
            <pre key={i} className="overflow-x-auto overscroll-contain rounded-[var(--radius-control)] bg-raised p-2 font-mono text-xs" tabIndex={0}>
              {b.v}
            </pre>
          )
        if (b.t === 'table') {
          const al = (c: number) => (b.align[c] === 'right' ? 'text-right' : b.align[c] === 'center' ? 'text-center' : 'text-left')
          return (
            <div key={i} role="region" aria-label={t('asst.md.table')} tabIndex={0} className="max-h-72 overflow-auto overscroll-contain rounded-[var(--radius-control)] border border-border">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-raised">
                  <tr>
                    {b.head.map((h, c) => (
                      <th key={c} scope="col" className={`px-2 py-1.5 font-medium ${al(c)}`}>
                        <InlineView nodes={h} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j} className="border-t border-border">
                      {r.map((cell, c) => (
                        <td key={c} className={`px-2 py-1.5 align-top ${al(c)}`}>
                          <InlineView nodes={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (b.t === 'ul')
          return (
            <ul key={i} className="list-disc pl-5">
              {b.v.map((li, j) => (
                <li key={j}>
                  <InlineView nodes={li} />
                </li>
              ))}
            </ul>
          )
        if (b.t === 'ol')
          return (
            <ol key={i} className="list-decimal pl-5">
              {b.v.map((li, j) => (
                <li key={j}>
                  <InlineView nodes={li} />
                </li>
              ))}
            </ol>
          )
        return (
          <p key={i} className="whitespace-pre-wrap">
            <InlineView nodes={b.v} />
          </p>
        )
      })}
    </div>
  )
}
