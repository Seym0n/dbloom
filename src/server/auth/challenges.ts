/** Package C (`challenges.ts`, FR-AUT-011, SEC-TGT-152): server-held challenges, bound to an owner and a purpose.
 *
 * Owner = session id hash, or the SHA-256 of the pre-authentication or setup cookie. One challenge per owner and
 * purpose; `take` deletes it whether the caller succeeds or not (single use); `countTry` is for code steps that
 * allow CHALLENGE_MAX_TRIES attempts on one challenge. Memory only, bounded.
 */
import { randomBytes } from 'node:crypto'
import { CHALLENGE_MAX_TRIES, CHALLENGE_TTL_MS, type ChallengePurpose, type ChallengeRecord, type ChallengeStore, type UserId } from './types'

const MAX_CHALLENGES = 20_000

export function createChallengeStore(now: () => number = Date.now): ChallengeStore {
  const byOwner = new Map<string, Map<ChallengePurpose, ChallengeRecord>>()
  let count = 0

  const live = (rec: ChallengeRecord | undefined) => (rec && now() < rec.expiresAt ? rec : undefined)
  const remove = (owner: string, purpose: ChallengePurpose) => {
    const inner = byOwner.get(owner)
    if (!inner?.delete(purpose)) return
    count -= 1
    if (inner.size === 0) byOwner.delete(owner)
  }
  const prune = () => {
    for (const [owner, inner] of byOwner) for (const [purpose, rec] of inner) if (!live(rec)) remove(owner, purpose)
    // Owners are attacker-chosen (pre-auth cookies): when still full of live records, drop the oldest ones.
    for (const [owner, inner] of byOwner) {
      if (count < MAX_CHALLENGES) break
      for (const purpose of [...inner.keys()]) remove(owner, purpose)
    }
  }

  return {
    create(owner: string, purpose: ChallengePurpose, data: { userId?: UserId; challenge?: string } = {}) {
      if (count >= MAX_CHALLENGES) prune()
      const previous = live(byOwner.get(owner)?.get(purpose))
      const record: ChallengeRecord = {
        id: randomBytes(16).toString('base64url'),
        owner,
        purpose,
        ...(data.userId === undefined ? {} : { userId: data.userId }),
        ...(data.challenge === undefined ? {} : { challenge: data.challenge }),
        expiresAt: now() + CHALLENGE_TTL_MS,
        // Asking for new options must not reset the tries of a running code step.
        tries: previous?.tries ?? 0,
      }
      if (previous) remove(owner, purpose)
      let inner = byOwner.get(owner)
      if (!inner) byOwner.set(owner, (inner = new Map()))
      inner.set(purpose, record)
      count += 1
      return record
    },
    take(owner: string, purpose: ChallengePurpose) {
      const record = live(byOwner.get(owner)?.get(purpose))
      remove(owner, purpose)
      return record
    },
    countTry(owner: string, purpose: ChallengePurpose) {
      const record = live(byOwner.get(owner)?.get(purpose))
      if (!record) {
        remove(owner, purpose)
        return undefined
      }
      record.tries += 1
      // The last allowed try is returned; the challenge is gone afterwards.
      if (record.tries >= CHALLENGE_MAX_TRIES) remove(owner, purpose)
      return { ...record }
    },
    dropOwner(owner: string) {
      const inner = byOwner.get(owner)
      if (!inner) return
      count -= inner.size
      byOwner.delete(owner)
    },
  }
}

export const challenges: ChallengeStore = createChallengeStore()
