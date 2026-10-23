/**
 * In-package UUIDv7 polyfill: browser-core currently provides only UUIDv4.
 * RFC 9562 section 5.7: 48-bit Unix milliseconds, version 7, RFC variant 10,
 * and 74 random bits. Secure randomness is required; callers may omit optional
 * diagnostics if unavailable. IDs are not monotonically ordered within a millisecond.
 */
export function generateUUIDv7(): string {
  const timestamp = Date.now()
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new RangeError('UUIDv7 timestamp must fit in 48 bits')
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  for (let index = 0; index < 6; index++) {
    bytes[index] = Math.floor(timestamp / 2 ** ((5 - index) * 8)) & 0xff
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
