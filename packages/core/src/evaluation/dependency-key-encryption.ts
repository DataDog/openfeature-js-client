import { base64Decode } from '@bufbuild/protobuf/wire'
import { gcm } from '@noble/ciphers/aes'
import type { FlagKeyObfuscation } from '../configuration/flag-key-obfuscation'
import { encodeUtf8 } from '../utf8'
import { sha256 } from './sha256'

const AAD = /* @__PURE__ */ encodeUtf8('datadog.feature-flags.dependency-key.v1\0')
const INFO = /* @__PURE__ */ encodeUtf8('datadog.feature-flags.dependency-key.v1')
const TAG_LENGTH = 16
const NONCE_LENGTH = 12

export function decryptDependencyFlagKey(
  encryptedFlagKey: string,
  rootFlagKey: string,
  encoding: FlagKeyObfuscation
): { key: string } | { error: string } {
  try {
    const envelope = decodeBase64Url(encryptedFlagKey)
    if (envelope.length < NONCE_LENGTH + TAG_LENGTH) throw new Error('Dependency flag-key ciphertext is too short')
    const nonce = envelope.subarray(0, NONCE_LENGTH)
    const ciphertext = envelope.subarray(NONCE_LENGTH)
    const plaintext = gcm(deriveKey(rootFlagKey, encoding.salt), nonce, AAD).decrypt(ciphertext)
    return { key: decodeUtf8(plaintext) }
  } catch {
    return { error: 'Invalid encrypted dependency flag key' }
  }
}

function deriveKey(rootFlagKey: string, saltHex: string): Uint8Array {
  const pseudoRandomKey = hmacSha256(hexToBytes(saltHex), encodeUtf8(rootFlagKey))
  const expandInput = new Uint8Array(INFO.length + 1)
  expandInput.set(INFO)
  expandInput[INFO.length] = 1
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

function decodeBase64Url(value: string): Uint8Array {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return base64Decode(base64)
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
