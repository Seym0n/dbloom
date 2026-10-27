/* eslint-disable @typescript-eslint/no-explicit-any */
import { AUTH_ENV, AUTH_SETTINGS, type AccountStore, type AuthSettingKey, type AuthSettingsResolver, type ResolvedAuthSettings, type SetupSiteSettingKey } from './types'
const parse = (v: string, schema: any) => { try { return schema.parse(JSON.parse(v)) } catch { return schema.parse(v) } }
export function createAuthSettingsResolver(store: AccountStore, env: NodeJS.ProcessEnv = process.env): AuthSettingsResolver {
  return { resolve() {
    const saved = new Map(store.getSettings().map(s=>[s.key,s.value])); const out: any = {}
    for (const key of Object.keys(AUTH_SETTINGS) as AuthSettingKey[]) {
      const spec:any=(AUTH_SETTINGS as any)[key]; let value:any=spec.default
      if (env[spec.env]) { const raw=env[spec.env]!; const n=Number(raw); value=typeof spec.default==='number'&&!Number.isNaN(n)?n:parse(raw,spec.schema) }
      if (saved.has(key) && spec.source !== 'env') value=parse(saved.get(key)!,spec.schema)
      if (spec.floor !== undefined && typeof value === 'number') value=Math.max(spec.floor,value)
      if (spec.ceiling !== undefined && typeof value === 'number') value=Math.min(spec.ceiling,value)
      out[key]=spec.schema.parse(value)
    }
    out.publicOrigin=env[AUTH_ENV.publicOrigin]??null; out.rpId=out.publicOrigin ? new URL(out.publicOrigin).hostname : null
    out.setupNetworks=(env[AUTH_ENV.setupNetworks]??'').split(',').map(s=>s.trim()).filter(Boolean); out.breachedListPath=env[AUTH_ENV.breachedList]??null
    return out as ResolvedAuthSettings
  }, write(values: Partial<Pick<ResolvedAuthSettings, SetupSiteSettingKey>>, by: string) {
    const at=Date.now(); for(const [key,value] of Object.entries(values)) { const spec:any=(AUTH_SETTINGS as any)[key]; if(!spec)continue; const parsed=spec.schema.parse(value); store.setSetting({key:key as AuthSettingKey,value:JSON.stringify(parsed),updatedAt:at,updatedBy:by}) }
  }}
}
