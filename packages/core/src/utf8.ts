export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
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
