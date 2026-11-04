import { createContext, useContext } from 'react'
import type { TlsMode } from './connections-logic'

/**
 * The operator's connection security (DBLOOM_TARGET_TLS) as the connection forms see it: the weakest option they offer
 * and the one they start on. `verify` until the session says otherwise, which is the strictest and so the safe default.
 */
export const TargetTlsContext = createContext<TlsMode>('verify')
export const useTargetTls = (): TlsMode => useContext(TargetTlsContext)
