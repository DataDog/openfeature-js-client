import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Paradigm,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { TypeMismatchError } from '@openfeature/web-sdk'

const OVERRIDES_KEY = 'dd.dd_flag.overrides'
const DEVTOOLS_MARKER_KEY = 'dd.dd_flag.devtools'

type DDFlagOverrideType = 'BOOLEAN' | 'STRING' | 'INTEGER' | 'NUMERIC' | 'JSON'

interface DDFlagOverride {
  type: DDFlagOverrideType
  value: boolean | string | number | JsonValue
}

function readOverrides(): Record<string, DDFlagOverride> {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? '{}') as Record<string, DDFlagOverride>
  } catch {
    return {}
  }
}

const EXPECTED_JS_TYPES: Record<DDFlagOverrideType, string> = {
  BOOLEAN: 'boolean',
  STRING: 'string',
  INTEGER: 'number',
  NUMERIC: 'number',
  JSON: 'object',
}

/**
 * Wraps any OpenFeature Provider to add localStorage-based flag overrides for local development.
 *
 * Overrides are loaded once on initialize() from localStorage['dd.dd_flag.overrides'].
 * On override hit, returns the value with flagMetadata.overridden = true and reason STATIC.
 * On miss, delegates to the inner provider unchanged.
 *
 * Usage:
 *   OpenFeature.setProvider(new DatadogDevtools(new DatadogProvider(...)))
 *
 * Set overrides in localStorage:
 *   localStorage.setItem('dd.dd_flag.overrides', JSON.stringify({
 *     'my-flag': { type: 'BOOLEAN', value: true }
 *   }))
 */
export class DatadogDevtools implements Provider {
  readonly metadata: ProviderMetadata = { name: 'DatadogDevtools' }
  readonly runsOn: Paradigm = 'client'

  private overrides: Record<string, DDFlagOverride> = {}

  constructor(private readonly inner: Provider) {}

  get hooks() {
    return this.inner.hooks
  }

  get events() {
    return this.inner.events
  }

  get status() {
    return this.inner.status
  }

  async initialize(context?: EvaluationContext): Promise<void> {
    this.overrides = readOverrides()
    try {
      localStorage.setItem(DEVTOOLS_MARKER_KEY, 'enabled')
    } catch {}
    await this.inner.initialize?.(context)
  }

  async onClose(): Promise<void> {
    try {
      localStorage.removeItem(DEVTOOLS_MARKER_KEY)
    } catch {}
    await this.inner.onClose?.()
  }

  onContextChange(oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> | void {
    return this.inner.onContextChange?.(oldContext, newContext)
  }

  private resolveOverride<T>(flagKey: string, expectedTypes: DDFlagOverrideType[]): ResolutionDetails<T> | null {
    const override = this.overrides[flagKey]
    if (!override || !expectedTypes.includes(override.type)) {
      return null
    }
    if (override.value === null || typeof override.value !== EXPECTED_JS_TYPES[override.type]) {
      const msg = `[DatadogDevtools] override for '${flagKey}' declares type ${override.type} but value is ${typeof override.value} — override ignored`
      console.warn(msg)
      throw new TypeMismatchError(msg)
    }
    if (override.type === 'INTEGER' && !Number.isInteger(override.value)) {
      const msg = `[DatadogDevtools] override for '${flagKey}' declares type INTEGER but value ${override.value} is not a whole number — override ignored`
      console.warn(msg)
      throw new TypeMismatchError(msg)
    }
    return { value: override.value as T, reason: 'STATIC', flagMetadata: { overridden: true } }
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<boolean> {
    return this.resolveOverride<boolean>(flagKey, ['BOOLEAN']) ?? this.inner.resolveBooleanEvaluation(flagKey, defaultValue, context, logger)
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<string> {
    return this.resolveOverride<string>(flagKey, ['STRING']) ?? this.inner.resolveStringEvaluation(flagKey, defaultValue, context, logger)
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<number> {
    return (
      this.resolveOverride<number>(flagKey, ['INTEGER', 'NUMERIC']) ??
      this.inner.resolveNumberEvaluation(flagKey, defaultValue, context, logger)
    )
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<T> {
    return this.resolveOverride<T>(flagKey, ['JSON']) ?? this.inner.resolveObjectEvaluation(flagKey, defaultValue, context, logger)
  }
}
