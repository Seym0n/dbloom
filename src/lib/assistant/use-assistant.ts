import { useCallback, useEffect, useRef, useState } from 'react'
import { t, tDynamic } from '~/i18n'
import { assistantApi, assistantErrorCode, type AssistantMode, type Status, type Summary } from '~/lib/assistant/api'
import { appendItems, pollDelayMs, type Item } from '~/lib/assistant/logic'
import type { RunStatus } from '~/server/assistant/service'

/**
 * State of the assistant sidebar: availability, the conversation list, the open conversation with its log, and the poll
 * loop that follows a running turn (SPEC/34 task 5). Lives in the host component, so moving the panel between the side and
 * the large dialog keeps all of it.
 */
export function useAssistant() {
  const [status, setStatus] = useState<Status | undefined>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [list, setList] = useState<Summary[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [run, setRun] = useState<RunStatus>('idle')
  const [mode, setModeState] = useState<AssistantMode>('manual')
  const [error, setError] = useState<string | null>(null)

  const next = useRef(0)
  const quiet = useRef(0)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)

  const fail = useCallback((e: unknown) => setError(tDynamic(`asst.api.${assistantErrorCode(e)}`, 'asst.api.unexpected')), [])

  const stopPolling = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])

  const pollOnce = useCallback(
    async (id: string, gen: number) => {
      try {
        const res = await assistantApi().poll(id, next.current)
        if (!alive.current || gen !== generation.current) return
        next.current = res.next
        if (res.events.length > 0) {
          quiet.current = 0
          setItems((prev) => appendItems(prev, res.events as Item[]))
        } else quiet.current += 1
        setRun(res.status)
        setModeState(res.mode)
        const delay = pollDelayMs(res.status, quiet.current)
        if (delay !== null) timer.current = setTimeout(() => void pollOnce(id, gen), delay)
      } catch (e) {
        if (!alive.current || gen !== generation.current) return
        setRun('idle')
        fail(e)
      }
    },
    [fail],
  )

  const startPolling = useCallback(
    (id: string) => {
      stopPolling()
      quiet.current = 0
      void pollOnce(id, generation.current)
    },
    [pollOnce, stopPolling],
  )

  const refreshList = useCallback(async () => {
    try {
      setList(await assistantApi().list())
    } catch (e) {
      fail(e)
    }
  }, [fail])

  const open = useCallback(
    async (id: string) => {
      generation.current += 1
      stopPolling()
      setError(null)
      try {
        const o = await assistantApi().open(id)
        if (!alive.current) return
        setCurrentId(id)
        setTitle(o.summary.title)
        setItems(o.items as Item[])
        next.current = o.next
        setRun(o.status)
        setModeState(o.mode)
        if (o.status === 'running') startPolling(id)
      } catch (e) {
        fail(e)
        await refreshList()
      }
    },
    [fail, refreshList, startPolling, stopPolling],
  )

  // availability and the list, once; the newest conversation opens by itself
  useEffect(() => {
    alive.current = true
    void (async () => {
      try {
        const s = await assistantApi().status()
        if (!alive.current) return
        setStatus(s)
        if (!s.available) return
        const l = await assistantApi().list()
        if (!alive.current) return
        setList(l)
        if (l[0]) await open(l[0].id)
      } catch {
        if (alive.current) setLoadFailed(true)
      }
    })()
    return () => {
      alive.current = false
      generation.current += 1
      stopPolling()
    }
  }, [open, stopPolling])

  const create = useCallback(async (): Promise<string | undefined> => {
    setError(null)
    try {
      const c = await assistantApi().create()
      setList((l) => [c, ...l.filter((x) => x.id !== c.id)])
      generation.current += 1
      stopPolling()
      setCurrentId(c.id)
      setTitle(c.title)
      setItems([])
      next.current = 0
      setRun('idle')
      setModeState(c.mode)
      return c.id
    } catch (e) {
      fail(e)
      return undefined
    }
  }, [fail, stopPolling])

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      setError(null)
      const id = currentId ?? (await create())
      if (!id) return false
      try {
        await assistantApi().send(id, text)
        setRun('running')
        startPolling(id)
        void refreshList()
        return true
      } catch (e) {
        fail(e)
        return false
      }
    },
    [create, currentId, fail, refreshList, startPolling],
  )

  const resolve = useCallback(
    async (callId: string, decision: 'approve' | 'deny') => {
      if (!currentId) return
      setError(null)
      try {
        await assistantApi().resolve(currentId, callId, decision)
        setRun('running')
        startPolling(currentId)
      } catch (e) {
        fail(e)
        startPolling(currentId)
      }
    },
    [currentId, fail, startPolling],
  )

  const setMode = useCallback(
    async (m: AssistantMode) => {
      if (!currentId) return
      setError(null)
      try {
        const r = await assistantApi().setMode(currentId, m)
        setModeState(r.mode)
        void refreshList()
      } catch (e) {
        fail(e)
      }
    },
    [currentId, fail, refreshList],
  )

  const stop = useCallback(async () => {
    if (!currentId) return
    try {
      await assistantApi().stop(currentId)
      startPolling(currentId)
    } catch (e) {
      fail(e)
    }
  }, [currentId, fail, startPolling])

  const rename = useCallback(
    async (name: string) => {
      if (!currentId) return
      try {
        const s = await assistantApi().rename(currentId, name)
        setTitle(s.title)
        void refreshList()
      } catch (e) {
        fail(e)
      }
    },
    [currentId, fail, refreshList],
  )

  const remove = useCallback(async () => {
    if (!currentId) return
    try {
      await assistantApi().remove(currentId)
      generation.current += 1
      stopPolling()
      setCurrentId(null)
      setItems([])
      setRun('idle')
      const l = await assistantApi().list()
      setList(l)
      if (l[0]) await open(l[0].id)
    } catch (e) {
      fail(e)
    }
  }, [currentId, fail, open, stopPolling])

  return {
    status,
    loadFailed,
    list,
    currentId,
    title: title || t('asst.untitled'),
    items,
    run,
    mode,
    error,
    dismissError: () => setError(null),
    open,
    create,
    send,
    resolve,
    setMode,
    stop,
    rename,
    remove,
  }
}

export type AssistantState = ReturnType<typeof useAssistant>
