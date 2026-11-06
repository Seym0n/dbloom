'use client'

import { useMemo, useState } from 'react'

type Platform = 'coolify' | 'compose' | 'local'
type Mode = 'account' | 'direct'

const TRUST: Record<Platform, string> = {
  coolify: '10.0.0.0/8,172.16.0.0/12',
  compose: '172.16.0.0/12',
  local: '172.16.0.0/12',
}

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
}

/** The hostname part only; the wizard builds the origin from it. */
function cleanHost(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
}

const PLATFORMS = [
  ['coolify', 'Coolify'],
  ['compose', 'Docker host with a proxy'],
  ['local', 'Local trial'],
] as const

export function EnvWizard() {
  const [platform, setPlatform] = useState<Platform>('coolify')
  const [host, setHost] = useState('dbloom.example.com')
  const [mode, setMode] = useState<Mode>('account')
  const [targets, setTargets] = useState('')
  const [privateTargets, setPrivateTargets] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [trust, setTrust] = useState<string | null>(null)
  const [pin, setPin] = useState(true)
  const [narrow, setNarrow] = useState(false)
  const [key, setKey] = useState('')
  const [copied, setCopied] = useState(false)

  const origin = platform === 'local' ? 'http://localhost:3000' : `https://${cleanHost(host) || 'dbloom.example.com'}`
  const trustValue = trust ?? TRUST[platform]
  const secretKey = key || '(click Generate key)'

  const env = useMemo(() => {
    const lines: string[] = []
    if (pin || mode === 'account') {
      lines.push('# Where users reach DBLoom (scheme and host, no path).', `DBLOOM_PUBLIC_ORIGIN=${origin}`)
    }
    if (narrow) {
      lines.push('# Addresses of your reverse proxy network (CIDR list).', `DBLOOM_TRUST_PROXY=${trustValue}`)
    }
    if (lines.length > 0) lines.push('')
    lines.push(`DBLOOM_LOGIN_MODE=${mode}`)
    if (mode === 'account') {
      lines.push('# Keep a copy outside the server. Without it, TOTP secrets and recovery codes in a backup are unusable.')
      lines.push(`DBLOOM_SECRET_KEY=${secretKey}`)
    } else {
      const list = targets
        .split(/[\s,]+/)
        .filter(Boolean)
        .join(',')
      if (list) lines.push(`DBLOOM_DIRECT_TARGETS=${list}`)
      else lines.push('# Users may type any server. Only do this behind other protections.', 'DBLOOM_DIRECT_FREE_FORM_ACK=true')
    }
    if (privateTargets) lines.push('DBLOOM_ALLOW_PRIVATE=true')
    if (readOnly) lines.push('DBLOOM_READ_ONLY=true')
    return lines.join('\n') + '\n'
  }, [pin, narrow, origin, trustValue, mode, secretKey, targets, privateTargets, readOnly])

  const ready = mode === 'direct' || key !== ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(env)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked: the text stays selectable */
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([env], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = '.env'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="wiz">
      <div className="wiz-form">
        <fieldset>
          <legend>Where will it run?</legend>
          <div className="wiz-choices stack">
            {PLATFORMS.map(([id, label]) => (
              <label key={id} className={platform === id ? 'on' : ''}>
                <input
                  type="radio"
                  name="platform"
                  checked={platform === id}
                  onChange={() => {
                    setPlatform(id)
                    setTrust(null)
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {platform !== 'local' && (pin || mode === 'account') && (
          <label className="wiz-field">
            <span>Public domain</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} autoComplete="off" />
            <small>Becomes {origin}. Must match the domain your proxy serves.</small>
          </label>
        )}

        {platform !== 'local' && (
          <label className="wiz-check">
            <input type="checkbox" checked={pin || mode === 'account'} disabled={mode === 'account'} onChange={(e) => setPin(e.target.checked)} />
            Pin the domain (recommended; required for DBLoom accounts)
          </label>
        )}

        <label className="wiz-check">
          <input type="checkbox" checked={narrow} onChange={(e) => setNarrow(e.target.checked)} />
          Only trust my proxy network (recommended)
        </label>
        {narrow && (
          <label className="wiz-field">
            <span>Proxy network (DBLOOM_TRUST_PROXY)</span>
            <input value={trustValue} onChange={(e) => setTrust(e.target.value)} spellCheck={false} autoComplete="off" />
            <small>
              {platform === 'coolify'
                ? 'A broad private range so it works out of the box. Narrow it: run docker network inspect coolify and use that subnet.'
                : 'Use the subnet of the Docker network your proxy shares with DBLoom.'}
            </small>
          </label>
        )}

        <fieldset>
          <legend>How do people sign in?</legend>
          <div className="wiz-choices">
            <label className={mode === 'account' ? 'on' : ''}>
              <input type="radio" name="mode" checked={mode === 'account'} onChange={() => setMode('account')} />
              DBLoom accounts
            </label>
            <label className={mode === 'direct' ? 'on' : ''}>
              <input type="radio" name="mode" checked={mode === 'direct'} onChange={() => setMode('direct')} />
              Database credentials
            </label>
          </div>
          <small>
            {mode === 'account'
              ? 'Users, second factors and saved connections live in DBLoom. Needs a server key.'
              : 'Users sign in with the database account itself. Nothing about users is stored.'}
          </small>
        </fieldset>

        {mode === 'account' ? (
          <div className="wiz-field">
            <span>Server key</span>
            <button type="button" className="wiz-btn" onClick={() => setKey(newKey())}>
              {key ? 'Generate another key' : 'Generate key'}
            </button>
            <small>Made in your browser, never sent anywhere.</small>
          </div>
        ) : (
          <label className="wiz-field">
            <span>Allowed servers (optional)</span>
            <input
              value={targets}
              onChange={(e) => setTargets(e.target.value)}
              placeholder="db.internal:3306, other:3306"
              spellCheck={false}
              autoComplete="off"
            />
            <small>Leave empty to let users type any server. Only do that behind other protections.</small>
          </label>
        )}

        <label className="wiz-check">
          <input type="checkbox" checked={privateTargets} onChange={(e) => setPrivateTargets(e.target.checked)} />
          My databases are on a private network (allow private addresses)
        </label>
        <label className="wiz-check">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          Read-only: nobody can change data
        </label>
      </div>

      <div className="wiz-out">
        <div className="wiz-bar">
          <strong>.env</strong>
          <span>
            <button type="button" className="wiz-btn" onClick={copy} disabled={!ready}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="wiz-btn" onClick={download} disabled={!ready}>
              Download
            </button>
          </span>
        </div>
        <pre aria-label="Generated .env file">
          <code>{env}</code>
        </pre>
        <p className="wiz-note">
          {!ready
            ? 'Generate a server key to finish the file.'
            : platform === 'coolify'
              ? 'In Coolify, paste these lines into the resource environment variables, then deploy.'
              : platform === 'local'
                ? 'Save as .env next to compose.yaml, then run docker compose -f compose.yaml -f compose.local.yaml up --build.'
                : 'Save as .env next to compose.yaml and run docker compose up -d. Your proxy must route the domain to container port 3000.'}
        </p>
      </div>
    </div>
  )
}
