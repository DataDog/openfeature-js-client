import { addTelemetryDebug, display } from '@datadog/browser-core'
import {
  type CanonicalFlagSelection,
  type FlagSelectionError,
  MAX_FLAG_SELECTION_KEY_PATTERN_BYTES,
  MAX_FLAG_SELECTION_TAG_BYTES,
  MAX_FLAG_SELECTION_VALUES,
} from '@datadog/flagging-core'

// From the RFC's Failure modes section, per https://datadoghq.atlassian.net/browse/FFL-3370
export const MAX_RULES_URL_BYTES = 8192

const FLAG_SELECTION_IGNORED_HEADER = 'DD-Flag-Selection-Ignored'

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

export function reportIgnoredFlagSelection(response: Response) {
  const reason = response.headers?.get(FLAG_SELECTION_IGNORED_HEADER)
  if (!reason) return
  display.error(`flagSelection was ignored by the server (${reason}). Loaded the full flag configuration.`)
  addTelemetryDebug('Flag selection ignored', { reason })
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
