/** When eligible local configuration may satisfy initialization readiness. */
export type LocalConfigurationAcceptance =
  | { readonly type: 'NETWORK_FAILURE' }
  | {
      readonly type: 'NETWORK_GRACE_PERIOD'
      /** Non-negative milliseconds from initialization; zero permits an immediate race. */
      readonly durationMs: number
    }
  | { readonly type: 'NEVER' }

/**
 * Proposed startup readiness contract. Providers do not consume this policy yet.
 * Readiness does not guarantee freshness or the existence of an individual flag.
 */
export interface ClientReadyPolicy {
  /** IMMEDIATE completes initialization without waiting for configuration. */
  readonly readiness: 'CONFIGURATION' | 'IMMEDIATE'
  /**
   * Required complete coverage within flagSelection. INITIAL_FLAGS uses the
   * intersection with initialFlags; a complete full configuration also qualifies.
   * A completed empty batch qualifies; a partial or invalid batch does not.
   */
  readonly configuration: 'ALL_SELECTED_FLAGS' | 'INITIAL_FLAGS'
  readonly local: {
    /** Eligible sources in preference order; does not enable persistence. */
    readonly sources: readonly ('MEMORY' | 'BOOTSTRAP' | 'PERSISTED_CACHE')[]
    /**
     * A grace period prefers network until expiry or terminal failure, then permits
     * eligible local data. It neither cancels the request nor succeeds without data.
     */
    readonly acceptAfter: LocalConfigurationAcceptance
    /**
     * Precomputed-context reuse only. Never relax client/environment/selection,
     * schema, or experimentation opt-out compatibility. BEST_EFFORT permits mismatch.
     */
    readonly context: 'FULL_MATCH' | 'TARGETING_KEY_MATCH' | 'BEST_EFFORT'
  }
}

/** Proposed presets; defining these does not change provider behaviour. */
export const ClientReadyPolicy = {
  /**
   * Models the browser online provider's network-first startup behaviour.
   * Bootstrap data occupies the current in-memory configuration slot today.
   * Network failure may use compatible local data; it need not produce READY.
   * This is not a claim that every SDK shares the browser's fallback behaviour.
   */
  DEFAULT: {
    readiness: 'CONFIGURATION',
    configuration: 'ALL_SELECTED_FLAGS',
    local: {
      sources: ['MEMORY', 'BOOTSTRAP', 'PERSISTED_CACHE'],
      acceptAfter: { type: 'NETWORK_FAILURE' },
      context: 'FULL_MATCH',
    },
  },
} as const satisfies { readonly DEFAULT: ClientReadyPolicy }
