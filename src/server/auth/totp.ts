/** Package A (`totp.ts`, FR-AUT-008, ST-058): own TOTP over HMAC-SHA-1, RFC 4226 HOTP and RFC 6238 validation.
 *
 * Accepts steps `now − window … now + window` above `lastStep` (replay block by the caller's store swap) and
 * answers the accepted step; comparison constant-time after a hash, never text equality. QR code as SVG (uqr).
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { renderSVG } from 'uqr'
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  type TotpService,
} from './types'

export class OwnTotp implements TotpService {
  newSecret(): Buffer {
    return randomBytes(TOTP_SECRET_BYTES)
  }

  /** RFC 4648 base32, uppercase, without padding (the standard form of an otpauth secret). */
  base32(secret: Buffer): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = 0
    let value = 0
    let out = ''
    for (const byte of secret) {
      value = (value << 8) | byte
      bits += 8
      while (bits >= 5) {
        out += alphabet[(value >>> (bits - 5)) & 31]
        bits -= 5
      }
    }
    if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
    return out
  }

  otpauthUri(secret: Buffer, issuer: string, account: string): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    const query = new URLSearchParams({
      secret: this.base32(secret),
      issuer,
      algorithm: TOTP_ALGORITHM,
      digits: String(TOTP_DIGITS),
      period: String(TOTP_PERIOD_SECONDS),
    })
    return `otpauth://totp/${label}?${query}`
  }

  qrSvg(uri: string): string {
    return renderSVG(uri)
  }

  verify(
    secret: Buffer,
    code: string,
    lastStep: number,
    window: number,
    nowMs: number,
  ): { ok: true; step: number } | { ok: false } {
    if (!/^\d{6}$/.test(code)) return { ok: false }
    const nowStep = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS)
    for (let step = nowStep - window; step <= nowStep + window; step += 1) {
      if (step < 0 || step <= lastStep) continue
      const candidate = hotp(secret, step)
      // Constant-time over equal-length hashes (section 5.4): compares the hash of both 6-digit strings.
      const a = Buffer.from(createHash('sha256').update(Buffer.from(candidate, 'utf8')).digest())
      const b = Buffer.from(createHash('sha256').update(Buffer.from(code, 'utf8')).digest())
      if (timingSafeEqual(a, b)) return { ok: true, step }
    }
    return { ok: false }
  }
}

export const totp = new OwnTotp()

/** RFC 4226: HMAC-SHA-1 over the 8-byte big-endian step, dynamic truncation, 6 digits. */
export function hotp(secret: Buffer, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const offset = (mac[mac.length - 1] ?? 0) & 0xf
  const bin =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff)
  return String(bin % 10 ** digits).padStart(digits, '0')
}
