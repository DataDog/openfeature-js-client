import { configureTextEncoding } from '@bufbuild/protobuf/wire'
import { encodeUtf8 } from '../utf8'

if (!hasUsableTextEncoding()) {
  configureTextEncoding({
    checkUtf8(value) {
      try {
        encodeURIComponent(value)
        return true
      } catch {
        return false
      }
    },
    decodeUtf8,
    encodeUtf8,
  })
}

function hasUsableTextEncoding(): boolean {
  try {
    return (
      new globalThis.TextEncoder().encode('').length === 0 &&
      new globalThis.TextDecoder().decode(new Uint8Array()).length === 0
    )
  } catch {
    return false
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  let value = ''
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index++]
    let codePoint: number
    let continuationCount: number
    if (first <= 0x7f) {
      codePoint = first
      continuationCount = 0
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f
      continuationCount = 1
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f
      continuationCount = 2
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07
      continuationCount = 3
    } else {
      throw new Error('Invalid UTF-8')
    }

    for (let offset = 0; offset < continuationCount; offset++) {
      const continuation = bytes[index++]
      if (continuation === undefined || (continuation & 0xc0) !== 0x80) throw new Error('Invalid UTF-8')
      codePoint = (codePoint << 6) | (continuation & 0x3f)
    }
    if (
      (continuationCount === 2 && codePoint < 0x800) ||
      (continuationCount === 3 && codePoint < 0x10000) ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new Error('Invalid UTF-8')
    }
    value += String.fromCodePoint(codePoint)
  }
  return value
}
