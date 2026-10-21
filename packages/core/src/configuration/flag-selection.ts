import { compareBytes, encodeUtf8 } from '../utf8'

export interface FlagSelection {
  tags?: string[]
  keyPatterns?: string[]
}

export interface CanonicalFlagSelection {
  tags: string[]
  keyPatterns: string[]
}

export type FlagSelectionError = 'malformed_selection' | 'too_many_values' | 'invalid_key_pattern' | 'invalid_tag'

export interface CanonicalizeFlagSelectionResult {
  selection?: CanonicalFlagSelection
  error?: FlagSelectionError
}

export const MAX_FLAG_SELECTION_VALUES = 31
export const MAX_FLAG_SELECTION_TAG_BYTES = 200
export const MAX_FLAG_SELECTION_KEY_PATTERN_BYTES = 200

// The Unicode White_Space property, which Compute trims with Rust's str::trim.
// String.prototype.trim differs: it also trims U+FEFF and does not trim U+0085.
const WHITE_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]'
const SURROUNDING_WHITE_SPACE = new RegExp(`^${WHITE_SPACE}+|${WHITE_SPACE}+$`, 'g')

/**
 * Canonicalizes and validates a flag selection the same way Compute and ffe-service do.
 * Returns no selection when both lists are empty after canonicalization.
 */
export function canonicalizeFlagSelection(input: unknown): CanonicalizeFlagSelectionResult {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'malformed_selection' }
  if (Object.keys(input).some((key) => key !== 'tags' && key !== 'keyPatterns')) {
    return { error: 'malformed_selection' }
  }

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

function isOptionalStringList(value: unknown): value is string[] | undefined | null {
  return value === undefined || value === null || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
}

function canonicalizeList(values: string[]): string[] {
  const unique = new Set<string>()
  for (const value of values) {
    const trimmed = value.replace(SURROUNDING_WHITE_SPACE, '')
    if (trimmed) unique.add(trimmed)
  }
  return [...unique].sort((left, right) => compareBytes(encodeUtf8(left), encodeUtf8(right)))
}
