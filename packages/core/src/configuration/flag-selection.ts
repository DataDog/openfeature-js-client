import { compareBytes, encodeUtf8 } from '../utf8'

export interface FlagSelection {
  tags?: readonly string[]
  keyPatterns?: readonly string[]
}

/** @internal */
export interface CanonicalFlagSelection {
  tags: string[]
  keyPatterns: string[]
}

/** @internal */
export type FlagSelectionError = 'malformed_selection' | 'too_many_values' | 'invalid_key_pattern' | 'invalid_tag'

/** @internal */
export interface CanonicalizeFlagSelectionResult {
  selection?: CanonicalFlagSelection
  error?: FlagSelectionError
}

/** @internal */
export const MAX_FLAG_SELECTION_VALUES = 31
/** @internal */
export const MAX_FLAG_SELECTION_TAG_BYTES = 200
/** @internal */
export const MAX_FLAG_SELECTION_KEY_PATTERN_BYTES = 200

// Not String.prototype.isWellFormed (ES2024, outside the ES2018 target) or lookbehind (unsupported before Safari 16.4).
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Canonicalizes and validates a flag selection the same way Compute and ffe-service do.
 * Returns no selection when both lists are empty after canonicalization.
 * @internal
 */
export function canonicalizeFlagSelection(input: unknown): CanonicalizeFlagSelectionResult {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'malformed_selection' }
  const { tags: rawTags, keyPatterns: rawKeyPatterns } = input as Record<string, unknown>
  if (!isOptionalStringList(rawTags) || !isOptionalStringList(rawKeyPatterns)) {
    return { error: 'malformed_selection' }
  }

  const tags = canonicalizeList(rawTags ?? [])
  const keyPatterns = canonicalizeList(rawKeyPatterns ?? [])

  if (tags.length > MAX_FLAG_SELECTION_VALUES || keyPatterns.length > MAX_FLAG_SELECTION_VALUES) {
    return { error: 'too_many_values' }
  }
  if (keyPatterns.some((pattern) => encodeUtf8(pattern).length > MAX_FLAG_SELECTION_KEY_PATTERN_BYTES)) {
    return { error: 'invalid_key_pattern' }
  }
  if (tags.some((tag) => encodeUtf8(tag).length > MAX_FLAG_SELECTION_TAG_BYTES)) {
    return { error: 'invalid_tag' }
  }
  if (tags.length === 0 && keyPatterns.length === 0) return {}

  return { selection: { tags, keyPatterns } }
}

function isOptionalStringList(value: unknown): value is readonly string[] | undefined | null {
  if (value === undefined || value === null) return true
  if (!Array.isArray(value)) return false
  // An index loop visits holes, which every() skips.
  for (let i = 0; i < value.length; i++) {
    const v: unknown = value[i]
    if (typeof v !== 'string' || UNPAIRED_SURROGATE.test(v)) return false
  }
  return true
}

function canonicalizeList(values: readonly string[]): string[] {
  const unique = new Set<string>()
  for (const value of values) {
    const trimmed = trimWhiteSpace(value)
    if (trimmed) unique.add(trimmed)
  }
  return [...unique].sort((left, right) => compareBytes(encodeUtf8(left), encodeUtf8(right)))
}

// A trailing-anchored regular expression retries every interior white space run to its end, which is quadratic
// in the run length. This scan is linear.
function trimWhiteSpace(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && isWhiteSpace(value.charCodeAt(start))) start++
  while (end > start && isWhiteSpace(value.charCodeAt(end - 1))) end--
  return value.slice(start, end)
}

// The Unicode White_Space property, which Compute trims with Rust's str::trim. All 25 code points are in the BMP,
// so each is one UTF-16 code unit. String.prototype.trim differs: it also trims U+FEFF and does not trim U+0085.
function isWhiteSpace(code: number): boolean {
  return (
    (code >= 0x0009 && code <= 0x000d) ||
    code === 0x0020 ||
    code === 0x0085 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  )
}
