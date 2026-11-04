/**
 * Change notification for the settings resolver caches (SPEC/32 FR-ASE-014). The server runtime and the sign-in
 * runtime each cache the resolved settings for a few seconds; a successful write or reset calls `notifySettingsChanged`
 * so both drop the cache and the writer sees the new value at once. Kept on `globalThis` like the other process-wide
 * wiring: the build can bundle a module twice and a plain module variable would then not be shared.
 */
const KEY = Symbol.for('dbloom.settings.listeners')
type Listener = () => void
const listeners = (): Set<Listener> => {
  const g = globalThis as { [KEY]?: Set<Listener> }
  return (g[KEY] ??= new Set<Listener>())
}

/** Registers a cache invalidator; returns its unregister function. */
export function onSettingsChanged(fn: Listener): () => void {
  listeners().add(fn)
  return () => void listeners().delete(fn)
}

export function notifySettingsChanged(): void {
  for (const fn of [...listeners()]) {
    try {
      fn()
    } catch {
      // an invalidator that throws must not turn a committed write into a failure
    }
  }
}
