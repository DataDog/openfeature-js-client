import { TextEncoder } from 'node:util'
import { encodeUtf8 } from './utf8'

describe('UTF-8 encoding', () => {
  it('uses TextEncoder when available', () => {
    const encode = jest.spyOn(globalThis.TextEncoder.prototype, 'encode')
    try {
      expect(encodeUtf8('plain ASCII')).toEqual(new TextEncoder().encode('plain ASCII'))
      expect(encode).toHaveBeenCalledWith('plain ASCII')
    } finally {
      encode.mockRestore()
    }
  })

  it.each(['', 'plain ASCII', 'café', '你好', '😀', 'a😀é中', '\ud800', '\udc00'])(
    'matches TextEncoder for %j',
    (value) => {
      expect(encodeUtf8(value)).toEqual(new TextEncoder().encode(value))
    }
  )

  it('falls back when TextEncoder is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder')
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined })
    try {
      jest.isolateModules(() => {
        const { encodeUtf8: encodeWithFallback } = require('./utf8') as typeof import('./utf8')

        expect(encodeWithFallback('a😀é中')).toEqual(new TextEncoder().encode('a😀é中'))
      })
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'TextEncoder', descriptor)
    }
  })
})
