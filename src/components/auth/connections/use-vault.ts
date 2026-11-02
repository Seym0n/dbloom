import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { authApi } from '~/lib/auth/api'

export const VAULT_KEY = ['auth', 'vault'] as const
export const PROFILES_KEY = ['auth', 'profiles'] as const
export const CONNECTIONS_KEY = ['auth', 'connections'] as const

/** Vault state; asks again by itself when the auto-lock time has passed so the screen never shows a stale "unlocked". */
export function useVaultStatus() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: VAULT_KEY, queryFn: () => authApi().vaultStatus(), retry: false })
  const lockAt = query.data?.autoLockAt ?? null
  useEffect(() => {
    if (lockAt === null) return
    const id = window.setTimeout(() => void client.invalidateQueries({ queryKey: VAULT_KEY }), Math.max(0, lockAt - Date.now()) + 600)
    return () => window.clearTimeout(id)
  }, [lockAt, client])
  return query
}

export function useProfiles(enabled = true) {
  return useQuery({ queryKey: PROFILES_KEY, queryFn: () => authApi().listProfiles(), retry: false, enabled })
}

/** Refresh everything a vault or profile change can touch. */
export function useRefreshVault() {
  const client = useQueryClient()
  return () => Promise.all([client.invalidateQueries({ queryKey: VAULT_KEY }), client.invalidateQueries({ queryKey: PROFILES_KEY })])
}
