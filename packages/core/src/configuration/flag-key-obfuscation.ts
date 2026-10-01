import { sha256Hex } from '../evaluation/sha256'
import { encodeUtf8 } from '../utf8'

const SCHEME = 'flag-key-sha256-v1'
const DOMAIN = encodeUtf8('datadog.feature-flags.flag-key.v1\0')

/** Assignment encodings supported by the precomputed parser and evaluator. @internal */
export const SUPPORTED_ASSIGNMENT_ENCODINGS = [SCHEME] as const

/** Public metadata stored with the encoded assignment map. @internal */
export type FlagKeyObfuscation = {
  scheme: typeof SCHEME
  salt: string
}

/** Validate the response's encoding before parsing or looking up assignments. */
export function readFlagKeyObfuscation(
  obfuscated: unknown,
  obfuscation: unknown
): { encoding?: FlagKeyObfuscation } | { error: string } {
  if ((obfuscated === undefined || obfuscated === false) && obfuscation === undefined) {
    return {}
  }
  if (obfuscated !== true || typeof obfuscation !== 'object' || obfuscation === null || Array.isArray(obfuscation)) {
    return { error: 'Invalid precomputed flag-key obfuscation metadata' }
  }
  const descriptor = obfuscation as Record<string, unknown>
  if (descriptor.scheme !== SCHEME) {
    return { error: 'Unsupported precomputed flag-key obfuscation scheme' }
  }
  if (!isLowercaseHex(descriptor.salt, 16)) {
    return { error: 'Precomputed flag-key salt must contain 32 lowercase hexadecimal characters' }
  }
  return { encoding: { scheme: SCHEME, salt: descriptor.salt } }
}

/** Hash only the lookup key. Values and telemetry retain their original meaning. */
export function encodePrecomputedFlagKey(
  key: string,
  encoding: FlagKeyObfuscation
): { key: string } | { error: string } {
  // TextEncoder replaces invalid surrogates. Reject them instead of aliasing
  // a different flag whose name contains the Unicode replacement character.
  if (!isWellFormedUnicode(key)) return { error: 'Flag key must contain valid Unicode' }

  const keyBytes = encodeUtf8(key)
  const input = new Uint8Array(DOMAIN.length + 16 + keyBytes.length)
  input.set(DOMAIN)
  for (let index = 0; index < 16; index++) {
    input[DOMAIN.length + index] = Number.parseInt(encoding.salt.slice(index * 2, index * 2 + 2), 16)
  }
  input.set(keyBytes, DOMAIN.length + 16)
  return { key: sha256Hex(input) }
}

/** Check the exact byte length and alphabet of a hex-encoded wire value. */
export function isLowercaseHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/.test(value)
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}
