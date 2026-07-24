import { createHash } from 'node:crypto'
import { sha256Hex } from './sha256'

describe('sha256Hex', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1024])('matches Node crypto for a %i-byte input', (length) => {
    const input = Uint8Array.from({ length }, (_, index) => (index * 31 + 17) & 0xff)
    const expected = createHash('sha256').update(input).digest('hex')

    expect(sha256Hex(input)).toBe(expected)
  })
})
