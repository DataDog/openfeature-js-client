import { configureTextEncoding } from '@bufbuild/protobuf/wire'
import { decodeUtf8, encodeUtf8 } from '../utf8'

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
