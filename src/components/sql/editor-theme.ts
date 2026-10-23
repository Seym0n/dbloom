import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

/**
 * Editor look from the shell tokens, so light and dark follow the app (CSS variables, no JS theme switch).
 * Colours stay quiet: keywords in ink at 600, strings and numbers in the accent, comments faint.
 */
export const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'var(--surface)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px', overflow: 'auto' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--faint)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '32px' },
  '.cm-activeLine': { backgroundColor: 'var(--raised)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--raised)', color: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
    { backgroundColor: 'var(--active)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-sql-error': {
    textDecoration: 'underline wavy var(--negative)',
    textUnderlineOffset: '3px',
    backgroundColor: 'var(--pill-negative-bg)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgb(0 0 0 / 0.12)',
    color: 'var(--text)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    maxHeight: 'min(40vh, 320px)',
    minWidth: '220px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--active)',
    color: 'var(--text)',
  },
  '.cm-completionDetail': { color: 'var(--faint)', fontStyle: 'normal', marginLeft: '12px' },
})

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier],
    color: 'var(--text)',
    fontWeight: '600',
  },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--accent)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--accent)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--faint)',
    fontStyle: 'italic',
  },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--muted)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--muted)' },
])

export const editorHighlight = syntaxHighlighting(highlight)
