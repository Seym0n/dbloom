export type SessionRecord = {
  /** SHA-256 of the cookie token, hex. The token itself is never stored. */
  idHash: string
  /** Normalised target key (DATA-TGT-094). */
  targetKey: string
  userName: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

export interface Store {
  createSession(record: SessionRecord): void
  getSession(idHash: string): SessionRecord | undefined
  touchSession(idHash: string, lastSeenAt: number): void
  deleteSession(idHash: string): void
  purgeSessions(olderThanExpiry: number): number
  close(): void
}
