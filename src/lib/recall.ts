/**
 * The "remember the last server and user name" of the direct login page (ST-074, FR-AUT-019). Only when the operator turns
 * `DBLOOM_LOGIN_RECALL` on. It keeps a server (`host:port`) and a user name in the browser's local storage and nothing
 * else: never a password, never a token, never a session. Pure over a storage object, so tests pass a fake.
 */
export const RECALL_KEY = 'dbloom.recall'

export type Recall = { server: string; username: string }

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const CONTROL = /[\u0000-\u001f\u007f]/
const valid = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v)

/** The saved pair, or null when nothing usable is stored (absent, broken JSON, wrong shape, odd characters, storage error). */
export function readRecall(storage: Store | undefined): Recall | null {
  try {
    const raw = storage?.getItem(RECALL_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<Recall>
    if (valid(o.server, 255) && valid(o.username, 128)) return { server: o.server, username: o.username }
  } catch {
    // a broken entry is the same as none
  }
  return null
}

export function saveRecall(storage: Store | undefined, value: Recall): void {
  try {
    if (!valid(value.server, 255) || !valid(value.username, 128)) return
    storage?.setItem(RECALL_KEY, JSON.stringify({ server: value.server, username: value.username }))
  } catch {
    // storage may be full or blocked
  }
}

export function clearRecall(storage: Store | undefined): void {
  try {
    storage?.removeItem(RECALL_KEY)
  } catch {
    // nothing to do
  }
}

/** The named server to preselect: the remembered one when it is still on the list (or the list is empty), else none. */
export function preselected(remembered: Recall | null, named: string[] | undefined): Recall | null {
  if (!remembered) return null
  if (!named || named.length === 0) return remembered
  const norm = (s: string) => s.trim().toLowerCase()
  return named.some((n) => norm(n) === norm(remembered.server)) ? remembered : null
}
