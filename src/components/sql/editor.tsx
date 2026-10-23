import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react'
import { autocompletion, startCompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, toggleComment } from '@codemirror/commands'
import { MariaSQL, MySQL, sql } from '@codemirror/lang-sql'
import { bracketMatching } from '@codemirror/language'
import {
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { createSqlCompletion, type CompletionHost } from './completion'
import { editorHighlight, editorTheme } from './editor-theme'
import { t } from '~/i18n'

export type Product = 'mysql' | 'mariadb'

export type EditorApi = {
  getText: () => string
  getSelection: () => { from: number; to: number }
  getCursor: () => number
  /** Replaces the whole text as one undoable change. */
  setText: (text: string) => void
  focus: () => void
  /** Marks a range as the error position; any edit clears it. */
  markError: (range: { from: number; to: number } | null) => void
  select: (from: number, to: number) => void
  resetCompletion: () => void
}

/** Commands the keymap calls; kept in a ref so the editor is created once and never rebuilt. */
export type EditorCommands = {
  run: () => void
  runStatement: () => void
  explain: () => void
  saveBookmark: () => void
  /** Returns true when it consumed Escape (a run is going on). */
  cancel: () => boolean
}

const setError = StateEffect.define<{ from: number; to: number } | null>()
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setError)) {
        const r = e.value
        if (!r) return Decoration.none
        const to = Math.min(Math.max(r.to, r.from + 1), tr.state.doc.length)
        const from = Math.min(r.from, to)
        return from >= to
          ? Decoration.none
          : Decoration.set([Decoration.mark({ class: 'cm-sql-error' }).range(from, to)])
      }
    }
    return tr.docChanged ? Decoration.none : value
  },
  provide: (f) => EditorView.decorations.from(f),
})

const dialectOf = (product: Product | undefined) =>
  sql({ dialect: product === 'mariadb' ? MariaSQL : MySQL })

function baseExtensions(label: string): Extension[] {
  return [
    editorTheme,
    editorHighlight,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      'aria-label': label,
      spellcheck: 'false',
      autocapitalize: 'off',
    }),
    errorField,
    drawSelection(),
    bracketMatching(),
  ]
}

/**
 * CodeMirror 6 in a small hook (no wrapper package). The view is created once; language, completion
 * switch and the host callbacks are reconfigured without recreating it, so the text, selection and undo
 * history survive. Unsaved text lives only in this view (memory), never in browser storage.
 */
export function useSqlEditor({
  api,
  initialDoc,
  product,
  commands,
  completion,
  completionOn,
  onChange,
  onSelectionChange,
}: {
  api: Ref<EditorApi>
  initialDoc: string
  product: Product | undefined
  commands: { current: EditorCommands }
  completion: CompletionHost
  completionOn: boolean
  onChange: (text: string) => void
  onSelectionChange?: (hasSelection: boolean) => void
}) {
  const parent = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const language = useRef(new Compartment())
  const complete = useRef(new Compartment())
  const hostRef = useRef(completion)
  hostRef.current = completion
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSelRef = useRef(onSelectionChange)
  onSelRef.current = onSelectionChange
  const completer = useMemo(
    () =>
      createSqlCompletion({
        db: () => hostRef.current.db(),
        product: () => hostRef.current.product(),
        enabled: () => hostRef.current.enabled(),
        fetchSchema: (i) => hostRef.current.fetchSchema(i),
      }),
    [],
  )

  useEffect(() => {
    if (!parent.current) return
    const mod = (key: string) => `Mod-${key}`
    const keys = Prec.highest(
      keymap.of([
        { key: mod('Enter'), run: () => (commands.current.run(), true) },
        { key: mod('Shift-Enter'), run: () => (commands.current.runStatement(), true) },
        { key: mod('Shift-e'), run: () => (commands.current.explain(), true) },
        { key: mod('s'), run: () => (commands.current.saveBookmark(), true) },
        { key: 'Escape', run: () => commands.current.cancel() },
        { key: mod('Space'), run: startCompletion },
        { key: mod('/'), run: toggleComment },
      ]),
    )
    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        keys,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        lineNumbers(),
        highlightActiveLine(),
        language.current.of(dialectOf(undefined)),
        complete.current.of(
          autocompletion({ override: [completer.source], icons: false, maxRenderedOptions: 200 }),
        ),
        ...baseExtensions(t('sql.editor.label')),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          if (u.selectionSet || u.docChanged) {
            const s = u.state.selection.main
            onSelRef.current?.(s.from !== s.to)
          }
        }),
      ],
    })
    const v = new EditorView({ state, parent: parent.current })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // The view is created once for the lifetime of the tab.
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(dialectOf(product)) })
  }, [product])

  useEffect(() => {
    view.current?.dispatch({
      effects: complete.current.reconfigure(
        completionOn
          ? autocompletion({ override: [completer.source], icons: false, maxRenderedOptions: 200 })
          : [],
      ),
    })
  }, [completionOn, completer])

  useImperativeHandle(
    api,
    (): EditorApi => ({
      getText: () => view.current?.state.doc.toString() ?? '',
      getSelection: () => {
        const s = view.current?.state.selection.main
        return { from: s?.from ?? 0, to: s?.to ?? 0 }
      },
      getCursor: () => view.current?.state.selection.main.head ?? 0,
      setText: (text) => {
        const v = view.current
        if (!v) return
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: text },
          selection: { anchor: text.length },
          scrollIntoView: true,
        })
      },
      focus: () => view.current?.focus(),
      markError: (range) => {
        const v = view.current
        if (!v) return
        v.dispatch({
          effects: setError.of(range),
          ...(range
            ? {
                selection: { anchor: Math.min(range.from, v.state.doc.length) },
                scrollIntoView: true,
              }
            : {}),
        })
      },
      select: (from, to) => {
        const v = view.current
        if (!v) return
        const max = v.state.doc.length
        v.dispatch({
          selection: { anchor: Math.min(from, max), head: Math.min(to, max) },
          scrollIntoView: true,
        })
        v.focus()
      },
      resetCompletion: () => completer.reset(),
    }),
    [completer],
  )

  return parent
}

/** Read-only highlighted SQL for the query strip and history entries (FR-UIX-066). */
export function SqlView({
  text,
  product,
  className,
}: {
  text: string
  product?: Product
  className?: string
}) {
  const parent = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!parent.current) return
    const v = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          dialectOf(product),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...baseExtensions(t('sql.view.label')),
          EditorView.theme({
            '.cm-content': { padding: '4px 0' },
            '&': { backgroundColor: 'transparent' },
          }),
        ],
      }),
      parent: parent.current,
    })
    return () => v.destroy()
  }, [text, product])
  return <div ref={parent} className={className} />
}
