import { generateUUIDv7 } from '../../src/transport/generateUUIDv7'

describe('UUIDv7 polyfill', () => {
  afterEach(() => jest.restoreAllMocks())

  it('encodes all 48 timestamp bits and sets version and variant while preserving random bits', () => {
    jest.spyOn(Date, 'now').mockReturnValue(0x0123456789ab)
    jest.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      ;(array as Uint8Array).fill(0xff)
      return array
    })
    expect(generateUUIDv7()).toBe('01234567-89ab-7fff-bfff-ffffffffffff')
  })

  it('creates distinct identities in the same millisecond', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    expect(new Set(Array.from({ length: 100 }, () => generateUUIDv7())).size).toBe(100)
  })

  it('rejects out-of-range timestamps and unavailable secure randomness', () => {
    jest.spyOn(Date, 'now').mockReturnValue(0x1000000000000)
    expect(generateUUIDv7).toThrow(RangeError)
    jest.spyOn(Date, 'now').mockReturnValue(1)
    jest.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('unavailable')
    })
    expect(generateUUIDv7).toThrow('unavailable')
  })
})
