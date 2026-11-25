import { addTelemetryDebug, display } from '@datadog/browser-core'
import {
  type CanonicalFlagSelection,
  type FlagSelectionError,
  MAX_FLAG_SELECTION_KEY_PATTERN_BYTES,
  MAX_FLAG_SELECTION_TAG_BYTES,
  MAX_FLAG_SELECTION_VALUES,
} from '@datadog/flagging-core'

// Fastly answers URLs over 8 KB with 414 URI Too Long: https://docs.fastly.com/products/network-services-resource-limits
export const MAX_RULES_URL_BYTES = 8192

const FLAG_SELECTION_IGNORED_HEADER = 'DD-Flag-Selection-Ignored'
const FLAG_SELECTION_IGNORED_REASONS: ReadonlySet<string> = new Set([
  'malformed_selection',
  'too_many_values',
  'invalid_key_pattern',
  'invalid_tag',
  'tag_load_failed',
])
// The longest known reason is 19 characters, so a longer value is unknown without a lookup.
const MAX_FLAG_SELECTION_IGNORED_REASON_LENGTH = 32

const LIMIT_DESCRIPTIONS: Record<FlagSelectionError, string> = {
  malformed_selection: 'flagSelection must be an object with optional tags and keyPatterns string arrays',
  too_many_values: `each list accepts at most ${MAX_FLAG_SELECTION_VALUES} values`,
  invalid_key_pattern: `each key pattern is at most ${MAX_FLAG_SELECTION_KEY_PATTERN_BYTES} UTF-8 bytes`,
  invalid_tag: `each tag is at most ${MAX_FLAG_SELECTION_TAG_BYTES} UTF-8 bytes`,
}

export function reportDroppedFlagSelection(reason: FlagSelectionError, limit = LIMIT_DESCRIPTIONS[reason]) {
  display.error(`flagSelection was not sent (${reason}: ${limit}). Loading the full flag configuration.`)
  addTelemetryDebug('Flag selection dropped', { reason })
}

// Call only once the configuration in the response has been accepted.
export function reportIgnoredFlagSelection(response: Response) {
  reportIgnoredFlagSelectionValue(response.headers?.get(FLAG_SELECTION_IGNORED_HEADER))
}

// A signed request passes only the verified value: a raw header on a signed response is not read again.
export function reportIgnoredFlagSelectionValue(value: string | null | undefined) {
  const reason = ignoredFlagSelectionReason(value)
  if (!reason) return
  display.error(`flagSelection was ignored by the server (${reason}). Loaded the full flag configuration.`)
  addTelemetryDebug('Flag selection ignored', { reason })
}

// A proxy can set this header, or reflect request headers into it, so only a known reason is reported as received.
// Repeated header fields arrive joined with ", " and are therefore unknown.
function ignoredFlagSelectionReason(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return value.length <= MAX_FLAG_SELECTION_IGNORED_REASON_LENGTH && FLAG_SELECTION_IGNORED_REASONS.has(value)
    ? value
    : 'unknown'
}

// Returns undefined when the URL with the selection would exceed MAX_RULES_URL_BYTES.
export function appendFlagSelectionToUrl(url: URL, selection: CanonicalFlagSelection): URL | undefined {
  const params = [
    ...selection.tags.map((tag) => `selected_flag_tags=${encodeQueryValue(tag)}`),
    ...selection.keyPatterns.map((pattern) => `selected_flag_key_patterns=${encodeQueryValue(pattern)}`),
  ]
  const withSelection = new URL(url.toString())
  withSelection.search = [withSelection.search.slice(1), ...params].filter(Boolean).join('&')
  // Every character is ASCII after percent-encoding, so the string length is the byte length.
  return withSelection.toString().length > MAX_RULES_URL_BYTES ? undefined : withSelection
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}
