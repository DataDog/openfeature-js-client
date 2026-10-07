import { TextDecoder, TextEncoder } from 'node:util'
import { decodeUtf8 } from './protobuf-text-encoding'

describe('UTF-8 decoding', () => {
  it.each(['', 'plain ASCII', 'café', '你好', '😀', 'a😀é中'])('matches fatal TextDecoder for %j', (value) => {
    const bytes = new TextEncoder().encode(value)
    const expected = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

    expect(decodeUtf8(bytes)).toBe(expected)
  })

  it.each([
    ['lone continuation byte', [0x80]],
    ['truncated sequence', [0xe2, 0x82]],
    ['overlong sequence', [0xc0, 0x80]],
    ['UTF-16 surrogate', [0xed, 0xa0, 0x80]],
    ['code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
  ])('rejects an invalid %s', (_, bytes) => {
    expect(() => decodeUtf8(Uint8Array.from(bytes))).toThrow('Invalid UTF-8')
  })
})
