import {
  createDependencyFlagKeyDecryptor,
  createDependencyFlagKeyEncryptor,
  decryptDependencyFlagKey,
  encryptDependencyFlagKey,
} from './dependency-key-encryption'

const encoding = {
  scheme: 'flag-key-sha256-v1',
  salt: '000102030405060708090a0b0c0d0e0f',
} as const

describe('dependency flag-key encryption', () => {
  it('matches the shared fixed vector and decrypts with the plaintext root key', () => {
    const encrypted = encryptDependencyFlagKey('new-payment-flow', 'checkout-redesign', encoding)

    expect(encrypted).toBe('Eb_cST-0-FZKdvcpKLHbDDG_CX2hK4Xfrw7h5o-47Gp6GyFntOGTZO3wmLg')
    expect(decryptDependencyFlagKey(encrypted, 'checkout-redesign', encoding)).toEqual({ key: 'new-payment-flow' })
  })

  it.each(['', 'café', 'cafe\u0301', '🚲/旗', 'a\0b'])('round-trips dependency key %j', (flagKey) => {
    const encrypted = encryptDependencyFlagKey(flagKey, 'root', encoding)

    expect(decryptDependencyFlagKey(encrypted, 'root', encoding)).toEqual({ key: flagKey })
  })

  it('round-trips a dependency batch with one root-relative crypto context', () => {
    const encrypt = createDependencyFlagKeyEncryptor('root', encoding)
    const decrypt = createDependencyFlagKeyDecryptor('root', encoding)

    expect(['first', 'second', 'third'].map(encrypt).map(decrypt)).toEqual([
      { key: 'first' },
      { key: 'second' },
      { key: 'third' },
    ])
  })

  it('rejects the wrong root key and modified ciphertext', () => {
    const encrypted = encryptDependencyFlagKey('parent', 'root', encoding)
    const replacement = encrypted[20] === 'A' ? 'B' : 'A'
    const modified = `${encrypted.slice(0, 20)}${replacement}${encrypted.slice(21)}`

    expect(decryptDependencyFlagKey(encrypted, 'other-root', encoding)).toEqual({
      error: 'Invalid encrypted dependency flag key',
    })
    expect(decryptDependencyFlagKey(modified, 'root', encoding)).toEqual({
      error: 'Invalid encrypted dependency flag key',
    })
  })

  it.each(['', '!', 'abcde', 'A'.repeat(37)])('rejects malformed envelope %j', (encrypted) => {
    expect(decryptDependencyFlagKey(encrypted, 'root', encoding)).toEqual({
      error: 'Invalid encrypted dependency flag key',
    })
  })
})
