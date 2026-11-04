/**
 * A small, safe Markdown for the assistant's text (SPEC/34 FR-AST-014). The result is a tree of plain data; the component
 * renders it with React, which escapes every string, so model output can never become HTML. Supported: paragraphs,
 * bullet and numbered lists, fenced code, `code`, **bold**, *italic*, [label](https://...) links and value tokens.
 * Images are never rendered (the alt text stays as text), raw HTML is shown as typed, and a link may only be http, https or
 * mailto. Nothing is ever fetched automatically.
 */

/** Same shape as the server's token (assistant/pii/tokens.ts); a test keeps the two equal. Not imported: that file is server only. */
export const TOKEN_SOURCE = '<([a-z][a-z0-9_]{0,31}):([a-z0-9]{4}):(\\d{1,6})>'

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: Inline[] }
  | { t: 'italic'; v: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; v: string }
  | { t: 'token'; v: string }

export type Block =
  | { t: 'p'; v: Inline[] }
  | { t: 'ul'; v: Inline[][] }
  | { t: 'ol'; v: Inline[][] }
  | { t: 'code'; v: string }

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"'`]+$/i
export const isSafeUrl = (u: string): boolean => SAFE_URL.test(u)

/** Value tokens the model quotes (`<email:ab12:3>`) are marked so the page can show them as hidden values. */
function withTokens(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(new RegExp(TOKEN_SOURCE, 'g'))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    out.push({ t: 'token', v: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = []
  let i = 0
  let buf = ''
  const flush = () => {
    if (buf) out.push(...withTokens(buf))
    buf = ''
  }
  while (i < src.length) {
    const rest = src.slice(i)
    let m: RegExpExecArray | null
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush()
      out.push({ t: 'code', v: m[1]! })
      i += m[0].length
    } else if (depth < 3 && (m = /^\*\*([^*\n]+)\*\*/.exec(rest))) {
      flush()
      out.push({ t: 'bold', v: parseInline(m[1]!, depth + 1) })
      i += m[0].length
    } else if (depth < 3 && (m = /^\*([^*\n]+)\*/.exec(rest))) {
      flush()
      out.push({ t: 'italic', v: parseInline(m[1]!, depth + 1) })
      i += m[0].length
    } else if ((m = /^!\[([^\]\n]*)\]\(([^)\n]*)\)/.exec(rest))) {
      // an image is never loaded: its alt text stays
      buf += m[1] ?? ''
      i += m[0].length
    } else if ((m = /^\[([^\]\n]+)\]\(([^)\s\n]+)\)/.exec(rest))) {
      if (isSafeUrl(m[2]!)) {
        flush()
        out.push({ t: 'link', href: m[2]!, v: m[1]! })
      } else buf += m[0]
      i += m[0].length
    } else {
      buf += src[i]
      i++
    }
  }
  flush()
  return out
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', v: parseInline(para.join('\n')) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^```/.test(line)) {
      endPara()
      const code: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!)
      blocks.push({ t: 'code', v: code.join('\n') })
      continue
    }
    const ul = /^\s*[-*] +(.*)$/.exec(line)
    const ol = /^\s*\d+[.)] +(.*)$/.exec(line)
    if (ul || ol) {
      endPara()
      const kind = ul ? 'ul' : 'ol'
      const items: Inline[][] = []
      while (i < lines.length) {
        const m = (kind === 'ul' ? /^\s*[-*] +(.*)$/ : /^\s*\d+[.)] +(.*)$/).exec(lines[i]!)
        if (!m) break
        items.push(parseInline(m[1]!))
        i++
      }
      i--
      blocks.push({ t: kind, v: items })
      continue
    }
    const heading = /^#{1,6} +(.*)$/.exec(line)
    if (heading) {
      endPara()
      blocks.push({ t: 'p', v: [{ t: 'bold', v: parseInline(heading[1]!) }] })
      continue
    }
    if (line.trim() === '') endPara()
    else para.push(line)
  }
  endPara()
  return blocks
}
