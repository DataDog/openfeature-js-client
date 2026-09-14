const textEncoder = getUsableTextEncoder()

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return textEncoder ? (textEncoder.encode(value) as Uint8Array<ArrayBuffer>) : encodeUtf8Fallback(value)
}

function getUsableTextEncoder(): TextEncoder | undefined {
  try {
    const encoder = new globalThis.TextEncoder()
    return encoder.encode('').length === 0 ? encoder : undefined
  } catch {
    return undefined
  }
}

function encodeUtf8Fallback(value: string): Uint8Array<ArrayBuffer> {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00)
        index++
      } else {
        codePoint = 0xfffd
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd
    }

    if (codePoint <= 0x7f) bytes.push(codePoint)
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      )
    }
  }
  return new Uint8Array(bytes)
}
