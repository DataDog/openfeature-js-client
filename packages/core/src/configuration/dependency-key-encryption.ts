import { gcm } from '@noble/ciphers/aes'
import { sha256 } from '../evaluation/sha256'
import { encodeUtf8 } from '../utf8'
import type { FlagKeyObfuscation } from './flag-key-obfuscation'

const AAD = /* @__PURE__ */ encodeUtf8('datadog.feature-flags.dependency-key.v1\0')
const ENCRYPTION_INFO = /* @__PURE__ */ encodeUtf8('datadog.feature-flags.dependency-key.v1\0enc')
const NONCE_KEY_INFO = /* @__PURE__ */ encodeUtf8('datadog.feature-flags.dependency-key.v1\0nonce')
const NONCE_DOMAIN = /* @__PURE__ */ encodeUtf8('datadog.feature-flags.dependency-key.nonce.v1\0')
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const TAG_LENGTH = 16
const NONCE_LENGTH = 12

/** Encrypt a plaintext prerequisite key for one plaintext root flag key. @internal */
export function encryptDependencyFlagKey(
  dependencyFlagKey: string,
  rootFlagKey: string,
  encoding: FlagKeyObfuscation
): string {
  return createDependencyFlagKeyEncryptor(rootFlagKey, encoding)(dependencyFlagKey)
}

/** Create an encryptor that reuses one root-relative key for a dependency batch. @internal */
export function createDependencyFlagKeyEncryptor(
  rootFlagKey: string,
  encoding: FlagKeyObfuscation
): (dependencyFlagKey: string) => string {
  const { encryptionKey, nonceKey } = deriveKeys(rootFlagKey, encoding.salt)
  return (dependencyFlagKey) => {
    const plaintext = encodeUtf8(dependencyFlagKey)
    const nonce = hmacSha256(nonceKey, concatenate(NONCE_DOMAIN, plaintext)).subarray(0, NONCE_LENGTH)
    const ciphertext = gcm(encryptionKey, nonce, AAD).encrypt(plaintext)
    return encodeBase64Url(concatenate(nonce, ciphertext))
  }
}

/** Authenticate and decrypt a prerequisite key using its caller-supplied plaintext root key. @internal */
export function decryptDependencyFlagKey(
  encryptedFlagKey: string,
  rootFlagKey: string,
  encoding: FlagKeyObfuscation
): { key: string } | { error: string } {
  return createDependencyFlagKeyDecryptor(rootFlagKey, encoding)(encryptedFlagKey)
}

/** Create a decryptor that reuses one root-relative key for a dependency batch. @internal */
export function createDependencyFlagKeyDecryptor(
  rootFlagKey: string,
  encoding: FlagKeyObfuscation
): (encryptedFlagKey: string) => { key: string } | { error: string } {
  const { encryptionKey } = deriveKeys(rootFlagKey, encoding.salt)
  return (encryptedFlagKey) => {
    try {
      const envelope = decodeBase64Url(encryptedFlagKey)
      if (envelope.length < NONCE_LENGTH + TAG_LENGTH) throw new Error('Dependency flag-key ciphertext is too short')
      const nonce = envelope.subarray(0, NONCE_LENGTH)
      const ciphertext = envelope.subarray(NONCE_LENGTH)
      const plaintext = gcm(encryptionKey, nonce, AAD).decrypt(ciphertext)
      return { key: decodeUtf8(plaintext) }
    } catch {
      return { error: 'Invalid encrypted dependency flag key' }
    }
  }
}

function deriveKeys(rootFlagKey: string, saltHex: string): { encryptionKey: Uint8Array; nonceKey: Uint8Array } {
  const pseudoRandomKey = hmacSha256(hexToBytes(saltHex), encodeUtf8(rootFlagKey))
  return {
    encryptionKey: hkdfExpand(pseudoRandomKey, ENCRYPTION_INFO),
    nonceKey: hkdfExpand(pseudoRandomKey, NONCE_KEY_INFO),
  }
}

function hkdfExpand(pseudoRandomKey: Uint8Array, info: Uint8Array): Uint8Array {
  const expandInput = new Uint8Array(info.length + 1)
  expandInput.set(info)
  expandInput[info.length] = 1
  return hmacSha256(pseudoRandomKey, expandInput)
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64)
  block.set(key.length > block.length ? sha256(key) : key)
  const inner = new Uint8Array(block.length + message.length)
  const outer = new Uint8Array(block.length + 32)
  for (let index = 0; index < block.length; index++) {
    inner[index] = block[index] ^ 0x36
    outer[index] = block[index] ^ 0x5c
  }
  inner.set(message, block.length)
  outer.set(sha256(inner), block.length)
  return sha256(outer)
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

function encodeBase64Url(value: Uint8Array): string {
  let output = ''
  for (let index = 0; index < value.length; index += 3) {
    const remaining = value.length - index
    const chunk = (value[index] << 16) | ((value[index + 1] ?? 0) << 8) | (value[index + 2] ?? 0)
    output += BASE64URL_ALPHABET[(chunk >>> 18) & 63]
    output += BASE64URL_ALPHABET[(chunk >>> 12) & 63]
    if (remaining > 1) output += BASE64URL_ALPHABET[(chunk >>> 6) & 63]
    if (remaining > 2) output += BASE64URL_ALPHABET[chunk & 63]
  }
  return output
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url')
  const output = new Uint8Array(Math.floor((value.length * 6) / 8))
  let buffer = 0
  let bits = 0
  let outputIndex = 0
  for (const character of value) {
    buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(character)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output[outputIndex++] = (buffer >>> bits) & 0xff
      buffer &= (1 << bits) - 1
    }
  }
  if (buffer !== 0) throw new Error('Invalid base64url padding bits')
  return output
}

function decodeUtf8(value: Uint8Array): string {
  return decodeURIComponent(Array.from(value, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''))
}

function hexToBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index++) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}
