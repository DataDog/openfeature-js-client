import {
  type FlagSelection,
  type FlagSelectionError,
  MAX_FLAG_SELECTION_KEY_PATTERN_BYTES,
  MAX_FLAG_SELECTION_TAG_BYTES,
  MAX_FLAG_SELECTION_VALUES,
} from '@datadog/flagging-core'

export interface ConfigurationSelectionOptions {
  /**
   * Request flags matching any of these tags or key patterns.
   * Best-effort: an invalid or over-limit selection is not sent.
   */
  flagSelection?: FlagSelection
  /** Reports dropped or server-ignored selections. Defaults to console. */
  logger?: { error(message: string): void }
}

type SelectionLogger = NonNullable<ConfigurationSelectionOptions['logger']>

const SELECTION_LIMIT_DESCRIPTIONS: Record<FlagSelectionError, string> = {
  malformed_selection: 'flagSelection must be an object with optional tags and keyPatterns string arrays',
  too_many_values: `each list accepts at most ${MAX_FLAG_SELECTION_VALUES} values`,
  invalid_key_pattern: `each key pattern is at most ${MAX_FLAG_SELECTION_KEY_PATTERN_BYTES} UTF-8 bytes`,
  invalid_tag: `each tag is at most ${MAX_FLAG_SELECTION_TAG_BYTES} UTF-8 bytes`,
}

export function reportDroppedFlagSelection(
  logger: SelectionLogger,
  reason: FlagSelectionError,
  limit = SELECTION_LIMIT_DESCRIPTIONS[reason]
): void {
  reportSelectionError(logger, `flagSelection was not sent (${reason}: ${limit}). Loading the full flag configuration.`)
}

export function reportIgnoredFlagSelection(logger: SelectionLogger, response: Response): void {
  const reason = response.headers.get('DD-Flag-Selection-Ignored')
  if (reason) {
    reportSelectionError(
      logger,
      `flagSelection was ignored by the server (${reason}). Loaded the full flag configuration.`
    )
  }
}

function reportSelectionError(logger: SelectionLogger, message: string): void {
  try {
    logger.error(message)
  } catch {
    // Diagnostics must not prevent configuration loading or replace a fetch error.
  }
}
