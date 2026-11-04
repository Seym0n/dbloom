import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREDENTIAL_FUNCTIONS, CREDENTIAL_PREFIXES, evaluateGate } from '~/server/net/gate'
import { cfg, req } from './gate-fixtures'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Registered pages and server routes: the generated route tree is the registry. */
function registeredPaths(): string[] {
  const tree = readFileSync('src/routeTree.gen.ts', 'utf8')
  const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(tree)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)':/g)].map((m) => m[1]!.replace(/\$[A-Za-z]+/g, 'x'))
}

/** Server functions: every `export const name = createServerFn` and its file, as the build names them. */
function serverFunctions(): { file: string; name: string }[] {
  const found: { file: string; name: string }[] = []
  for (const path of walk('src').filter((p) => /\.(ts|tsx)$/.test(p))) {
    const text = readFileSync(path, 'utf8')
    for (const m of text.matchAll(/export const (\w+) = createServerFn/g)) {
      found.push({ file: path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ''), name: m[1]! })
    }
  }
  return found
}

// Functions that take no credential. A new server function must be listed here or in CREDENTIAL_FUNCTIONS.
const NON_CREDENTIAL = new Set(
  [
    'listConnections closeConnection vaultStatus vaultLock listProfiles deleteProfile issueInvite listInvites revokeInvite',
    'issueRecovery getBootState getLoginPageInfo signOut listFactors passkeyRegisterOptions passkeyRename passkeyRemove totpStart',
    'listSessions revokeSession listNotices dismissNotice listUsers setUserStatus setUserRole deleteUser revokeUserSessions getDatabases getTables',
    'getTableRows analyseImport startImport resumeImport listImportFolder getIoCapabilities startExport getJob cancelJob',
    'listTemplates saveTemplate deleteTemplate getIoPrefs setIoPrefs getPrefs setPref exportPrefs importPrefs resetPrefs getRows',
    'countRows cancelCount getRowLimits readRow readCell openCell lookupRows referencingRows previewRows changeRows confirmRows',
    'getRowPrefs setRowPref getSessionInfo logout runSql confirmSql cancelSql explainSql planAnalyseSql estimateAffected',
    'listHistory deleteHistory saveBookmark listBookmarks renameBookmark deleteBookmark getCompletionSchema getSqlLimits',
    'getStructureLists previewStructure executeStructure getTableDefinition',
    'listAuditEvents listOwnAuditEvents getAuditStatus startAuditExport getExposure acknowledgeExposure',
    'getSettings previewSetting setSetting resetSetting',
  ]
    .join(' ')
    .split(/\s+/),
)

const isCredential = (n: string) => CREDENTIAL_FUNCTIONS.has(n) || CREDENTIAL_PREFIXES.some((p) => n.startsWith(p))

describe('route inventory: every registered route passes through the gate', () => {
  const paths = registeredPaths()
  const functions = serverFunctions()

  it('finds the known routes (the inventory is not empty)', () => {
    expect(paths).toEqual(expect.arrayContaining(['/', '/setup', '/api/health', '/api/ready', '/api/startup', '/api/rows/upload', '/api/io/upload']))
    expect(functions.length).toBeGreaterThan(80)
  })

  it('every page and server route answers a forged Host with 421 (all methods)', () => {
    const forged = { host: 'forged.invalid' }
    for (const pathname of paths) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const r = evaluateGate(req({ pathname, method, headers: forged }), cfg())
        expect(r, `${method} ${pathname}`).toMatchObject({ ok: false, status: 421 })
      }
    }
  })

  it('every server function answers a forged Host with 421 and a foreign Origin with 403', () => {
    for (const { file, name } of functions) {
      const pathname = `/_serverFn/${file}.${name}`
      expect(evaluateGate(req({ pathname, method: 'POST', headers: { host: 'forged.invalid' } }), cfg()), pathname).toMatchObject({ ok: false, status: 421 })
      expect(evaluateGate(req({ pathname, method: 'POST', headers: { origin: 'https://evil.example' } }), cfg()), pathname).toMatchObject({ ok: false, status: 403 })
      expect(evaluateGate(req({ pathname, method: 'POST', headers: { origin: 'https://db.example.org' } }), cfg()).ok, pathname).toBe(true)
    }
  })

  it('every server function is classified as credential or not (exactly once)', () => {
    const names = new Set(functions.map((f) => f.name))
    expect([...names].filter((n) => !isCredential(n) && !NON_CREDENTIAL.has(n))).toEqual([])
    expect([...names].filter((n) => isCredential(n) && NON_CREDENTIAL.has(n))).toEqual([])
    expect([...CREDENTIAL_FUNCTIONS].filter((n) => !names.has(n))).toEqual([])
    expect([...NON_CREDENTIAL].filter((n) => !names.has(n))).toEqual([])
  })

  it('credential functions are refused on a scheme mismatch, the others are not', () => {
    const headers = { 'x-forwarded-proto': 'http', origin: 'https://db.example.org' }
    for (const { file, name } of functions) {
      const r = evaluateGate(req({ pathname: `/_serverFn/${file}.${name}`, method: 'POST', headers }), cfg())
      expect(r.ok, name).toBe(!isCredential(name))
    }
  })

  it('the middleware is registered for every route (vite.config.ts) and the header hook is a plugin', () => {
    const config = readFileSync('vite.config.ts', 'utf8')
    expect(config).toMatch(/route: '\/\*\*', middleware: true, handler: '\.\/src\/server\/net\/gate-middleware\.ts'/)
    expect(config).toContain('./src/server/http/headers-plugin.ts')
    expect(config).toContain('generateFunctionId')
  })
})
