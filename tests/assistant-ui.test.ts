import { describe, expect, it } from 'vitest'
import { appendItems, approvalLeft, cellView, ITEMS_MAX, openApproval, pollDelayMs, settledBy, type Item } from '~/lib/assistant/logic'
import { isSafeUrl, parseInline, parseMarkdown, TOKEN_SOURCE } from '~/lib/assistant/markdown'
import { TOKEN_PATTERN, createTokenMap } from '~/server/assistant/pii/tokens'
import { assistantErrorCode } from '~/lib/assistant/api'
import assistantTexts from '~/i18n/assistant.json'

// SPEC/34 task 5: the pure parts of the sidebar.

const approval = (callId: string): Item => ({ type: 'approval', callId, sql: 'SELECT 1', sqlModel: 'SELECT 1', access: 'read', metadataOnly: false, expiresAt: 10_000 })
const result = (callId: string): Item => ({ type: 'result', callId, sql: 'SELECT 1', sqlModel: 'SELECT 1', ok: true, result: { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }, modelSaw: 'rows', anonymizedColumns: [] })

describe('approvals in the log', () => {
  it('the open one is the last approval while the conversation waits', () => {
    const items: Item[] = [{ type: 'user', text: 'q' }, approval('a')]
    expect(openApproval(items, 'awaiting_approval')).toMatchObject({ callId: 'a' })
    expect(openApproval(items, 'idle')).toBeUndefined()
    expect(openApproval(items, 'running')).toBeUndefined()
    expect(openApproval([], 'awaiting_approval')).toBeUndefined()
    expect(openApproval([approval('a'), result('a'), approval('b')], 'awaiting_approval')).toMatchObject({ callId: 'b' })
  })

  it('a card is settled by a result, a refusal or a denial of the same call, not of another', () => {
    const items: Item[] = [approval('a'), approval('b'), result('b'), { type: 'denied', callId: 'a', reason: 'user' }]
    expect(settledBy(items, 0)).toBe('denied')
    expect(settledBy(items, 1)).toBe('result')
    expect(settledBy([approval('a')], 0)).toBeUndefined()
    expect(settledBy([approval('a'), result('z')], 0)).toBeUndefined()
    expect(settledBy([{ type: 'user', text: 'x' }], 0)).toBeUndefined()
  })

  it('time left is m:ss and none once it ran out', () => {
    expect(approvalLeft(65_000, 0)).toBe('1:05')
    expect(approvalLeft(9_000, 0)).toBe('0:09')
    expect(approvalLeft(1_000, 1_000)).toBeNull()
    expect(approvalLeft(500, 1_000)).toBeNull()
  })
})

describe('log and polling', () => {
  it('the log grows and keeps the newest entries', () => {
    const a: Item[] = [{ type: 'user', text: '1' }]
    expect(appendItems(a, [])).toBe(a)
    expect(appendItems(a, [{ type: 'user', text: '2' }])).toHaveLength(2)
    const big = appendItems(Array.from({ length: ITEMS_MAX }, (_, i) => ({ type: 'user', text: String(i) }) as Item), [{ type: 'user', text: 'last' }])
    expect(big).toHaveLength(ITEMS_MAX)
    expect(big.at(-1)).toEqual({ type: 'user', text: 'last' })
    expect(big[0]).toEqual({ type: 'user', text: '1' })
  })

  it('polls quickly while the assistant works, then slower, and not at all while it waits or rests', () => {
    expect(pollDelayMs('running', 0)).toBe(600)
    expect(pollDelayMs('running', 5)).toBe(1200)
    expect(pollDelayMs('running', 30)).toBe(2500)
    expect(pollDelayMs('awaiting_approval', 0)).toBeNull()
    expect(pollDelayMs('idle', 0)).toBeNull()
  })

  it('cells: NULL, text, a cut value and binary', () => {
    expect(cellView(null)).toEqual({ kind: 'null', text: 'NULL' })
    expect(cellView('x')).toEqual({ kind: 'text', text: 'x' })
    expect(cellView({ cut: 'abc', length: 900 })).toEqual({ kind: 'cut', text: 'abc…' })
    expect(cellView({ binary: 'AA', size: 9 })).toEqual({ kind: 'binary', text: '[binary 9 B]' })
  })

  it('an API error is read by its code', () => {
    expect(assistantErrorCode(new Error('assistant_busy: The assistant is still working.'))).toBe('assistant_busy')
    expect(assistantErrorCode(new Error('assistant_not_found@3: x'))).toBe('assistant_not_found')
    expect(assistantErrorCode(new Error('boom'))).toBe('unexpected')
    expect(assistantErrorCode('x')).toBe('unexpected')
  })

  it('every code the service can answer has a text', () => {
    for (const code of ['assistant_busy', 'assistant_unavailable', 'assistant_not_found', 'assistant_wrong_target', 'assistant_auto_not_allowed', 'assistant_not_waiting', 'assistant_empty', 'assistant_message_too_long', 'unexpected']) {
      expect((assistantTexts as Record<string, string>)[`asst.api.${code}`], code).toBeTruthy()
    }
    for (const code of ['user-only', 'inference', 'unanalysable', 'token', 'audit', 'limit', 'unknown-tool', 'bad-arguments']) expect((assistantTexts as Record<string, string>)[`asst.refused.${code}`], code).toBeTruthy()
    for (const code of ['ai', 'rate_limited', 'step_limit', 'token_limit', 'busy', 'no_pending', 'approval_invalid']) expect((assistantTexts as Record<string, string>)[`asst.error.${code}`], code).toBeTruthy()
    for (const reason of ['user', 'expired', 'stopped', 'superseded']) expect((assistantTexts as Record<string, string>)[`asst.denied.${reason}`], reason).toBeTruthy()
    for (const reason of ['no-endpoint', 'bad-endpoint', 'disabled', 'no-model']) expect((assistantTexts as Record<string, string>)[`asst.unavailable.${reason}`], reason).toBeTruthy()
  })
})

describe('safe Markdown (FR-AST-014)', () => {
  it('paragraphs, lists, code, headings, bold, italic and code spans', () => {
    const blocks = parseMarkdown('# Title\n\nA **bold** and *soft* `code` line.\n\n- one\n- two\n\n1. first\n2) second\n\n```sql\nSELECT 1;\n```')
    expect(blocks.map((b) => b.t)).toEqual(['p', 'p', 'ul', 'ol', 'code'])
    expect(blocks[0]).toEqual({ t: 'p', v: [{ t: 'bold', v: [{ t: 'text', v: 'Title' }] }] })
    expect(blocks[2]).toMatchObject({ t: 'ul', v: [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two' }]] })
    expect(blocks[4]).toEqual({ t: 'code', v: 'SELECT 1;' })
    expect(parseInline('a **b** and *c* e').map((n) => n.t)).toEqual(['text', 'bold', 'text', 'italic', 'text'])
  })

  it('raw HTML stays text: nothing in the tree can become markup', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> and <img src=x onerror=alert(1)>')
    expect(JSON.stringify(blocks)).toContain('<script>alert(1)</script>')
    expect(blocks.every((b) => b.t === 'p')).toBe(true)
    expect(JSON.stringify(blocks)).not.toMatch(/"t":"(link|image)"/)
  })

  it('images are never loaded: the alt text stays, no node carries a source', () => {
    const nodes = parseInline('look ![a chart](https://evil.example/x.png?leak=1) here')
    expect(nodes.map((n) => n.t)).toEqual(['text'])
    expect(JSON.stringify(nodes)).not.toContain('evil.example')
    expect(nodes[0]).toEqual({ t: 'text', v: 'look a chart here' })
  })

  it('links: only http, https and mailto become links; the label is the typed text; bare addresses stay text', () => {
    expect(parseInline('[docs](https://example.com/a?b=1)')).toEqual([{ t: 'link', href: 'https://example.com/a?b=1', v: 'docs' }])
    expect(parseInline('[mail](mailto:a@b.example)')[0]).toMatchObject({ t: 'link' })
    for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](//evil.example)', '[x](ftp://x)', '[x](vbscript:y)']) {
      expect(parseInline(bad).some((n) => n.t === 'link'), bad).toBe(false)
    }
    expect(parseInline('see https://example.com now').map((n) => n.t)).toEqual(['text'])
    expect(isSafeUrl('https://a.example/p')).toBe(true)
    expect(isSafeUrl('https://a.example/<b>')).toBe(false)
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
  })

  it('value tokens are marked, in text and in lists, and the pattern equals the server token', () => {
    const nodes = parseInline('The customer is <email:ab12:3> and <name:cd34:10>.')
    expect(nodes.filter((n) => n.t === 'token').map((n) => (n as { v: string }).v)).toEqual(['<email:ab12:3>', '<name:cd34:10>'])
    expect(new RegExp(TOKEN_SOURCE).source).toBe(TOKEN_PATTERN.source)
    const map = createTokenMap('zz99')
    const token = map.tokenFor('email', 'x@y.example')
    expect(parseInline(token)).toEqual([{ t: 'token', v: token }])
  })

  it('unterminated markup is shown as typed and nothing loops', () => {
    expect(parseInline('**open and `code and [x](https://a.example').map((n) => n.t)).not.toContain('bold')
    expect(parseMarkdown('```\nnever closed')).toEqual([{ t: 'code', v: 'never closed' }])
    expect(parseMarkdown('')).toEqual([])
    const deep = '*'.repeat(500) + 'x' + '*'.repeat(500)
    expect(() => parseInline(deep)).not.toThrow()
  })
})

describe('markdown tables', () => {
  it('parses a pipe table with alignment, escaped pipes and ragged rows', () => {
    const blocks = parseMarkdown('Top:\n\n| Name | Total |\n|:--|--:|\n| Ada | 10 |\n| a\\|b |\n\nAfter')
    expect(blocks[1]).toMatchObject({ t: 'table', align: ['left', 'right'] })
    const table = blocks[1] as Extract<ReturnType<typeof parseMarkdown>[number], { t: 'table' }>
    expect(table.head).toHaveLength(2)
    expect(table.rows).toHaveLength(2)
    expect(table.rows[1]![0]).toEqual([{ t: 'text', v: 'a|b' }])
    expect(table.rows[1]![1]).toEqual([])
    expect(blocks[2]).toMatchObject({ t: 'p' })
  })
  it('leaves a line with a pipe but no separator row as text', () => {
    expect(parseMarkdown('a | b\nc | d')[0]).toMatchObject({ t: 'p' })
  })
})
