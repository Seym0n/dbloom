/**
 * Password strength meter (FR-UIX-080, FR-AUT-026). Advisory only: the server decides (FR-AUT-005). Length-based, no
 * composition rules; the user name and trivial patterns lower the level. Pure, so it is unit-tested.
 */
export const STRENGTH_LEVELS = ['tooShort', 'weak', 'fair', 'good', 'strong'] as const
export type StrengthLevel = (typeof STRENGTH_LEVELS)[number]

export type Strength = {
  /** 0 to 4, index into STRENGTH_LEVELS. */
  score: 0 | 1 | 2 | 3 | 4
  level: StrengthLevel
  containsUsername: boolean
  tooShort: boolean
}

const COMMON = ['password', 'passwort', 'qwerty', 'letmein', '123456', 'abcdef', 'welcome', 'admin', 'dbloom']

const codePoints = (s: string) => [...s]

/** Rough bits of entropy: log2 of the character pool times the effective length (repeats and runs count little). */
export function estimateBits(password: string): number {
  const chars = codePoints(password)
  if (chars.length === 0) return 0
  let pool = 0
  if (/[a-z]/.test(password)) pool += 26
  if (/[A-Z]/.test(password)) pool += 26
  if (/\d/.test(password)) pool += 10
  if (/[^A-Za-z0-9]/.test(password)) pool += 33
  const seen = new Set<string>()
  let effective = 0
  for (const c of chars) {
    effective += seen.has(c) ? 0.1 : 1
    seen.add(c)
  }
  let runs = 0
  for (let i = 2; i < chars.length; i++) {
    const a = chars[i - 2]!.codePointAt(0)!
    const b = chars[i - 1]!.codePointAt(0)!
    const c = chars[i]!.codePointAt(0)!
    if (b - a === c - b && Math.abs(b - a) === 1) runs += 1
  }
  effective = Math.max(0, effective - runs * 0.8)
  return effective * Math.log2(Math.max(pool, 2))
}

export function scorePassword(password: string, opts: { username?: string; minLength: number }): Strength {
  const length = codePoints(password).length
  const name = opts.username?.trim().toLowerCase() ?? ''
  const lower = password.toLowerCase()
  const containsUsername = name.length > 0 && lower.includes(name)
  const tooShort = length < opts.minLength
  if (length === 0 || tooShort) {
    return { score: 0, level: 'tooShort', containsUsername, tooShort }
  }
  let bits = estimateBits(password)
  if (COMMON.some((word) => lower.includes(word))) bits *= 0.5
  if (containsUsername) bits *= 0.5
  const score: Strength['score'] = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4
  return { score, level: STRENGTH_LEVELS[score], containsUsername, tooShort }
}
