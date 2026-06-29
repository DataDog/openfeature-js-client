import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Paradigm,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { FlagNotFoundError, TypeMismatchError } from '@openfeature/web-sdk'

const OVERRIDES_KEY = 'dd.dd_flag.overrides'
const DEVTOOLS_MARKER_KEY = 'dd.dd_flag.devtools'

type DDFlagOverrideType = 'BOOLEAN' | 'STRING' | 'INTEGER' | 'NUMERIC' | 'JSON'

interface DDFlagOverride {
  type: DDFlagOverrideType
  value: boolean | string | number | JsonValue
  variants?: Record<string, string>
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

function resolveOverride<T>(flagKey: string, expectedTypes: DDFlagOverrideType[]): ResolutionDetails<T> {
  const override = readOverrides()[flagKey]
  if (!override || !expectedTypes.includes(override.type)) {
    throw new FlagNotFoundError(`no override for '${flagKey}'`)
  }
  if (typeof override.value !== EXPECTED_JS_TYPES[override.type]) {
    throw new TypeMismatchError(
      `override for '${flagKey}' declares type ${override.type} but value is ${typeof override.value}`
    )
  }
  if (override.type === 'INTEGER' && !Number.isInteger(override.value)) {
    throw new TypeMismatchError(
      `override for '${flagKey}' declares type INTEGER but value ${override.value} is not a whole number`
    )
  }
  return { value: override.value as T, reason: 'STATIC', flagMetadata: { overridden: true } }
}

/**
 * A dev-only provider that applies flag overrides from localStorage (key: dd.dd_flag.overrides).
 * Intended to be composed in front of the real provider via MultiProvider + FirstMatchStrategy:
 *
 *   OpenFeature.setProvider(new MultiProvider([
 *     { provider: new DevToolsProvider(), name: 'devtools' },
 *     { provider: new DatadogProvider(...), name: 'datadog' },
 *   ]))
 *
 * On override hit: returns the override value with reason STATIC.
 * On miss: throws FlagNotFoundError so MultiProvider falls through to the next provider.
 *
 * Flag recording (discovery) is handled separately by a dedicated after hook (opt-in,
 * shipped in a follow-up PR) that captures the actual resolved value for every evaluation.
 */
export class DevToolsProvider implements Provider {
  readonly metadata: ProviderMetadata = { name: 'DevToolsProvider' }
  readonly runsOn: Paradigm = 'client'

  async initialize(_context?: EvaluationContext): Promise<void> {
    try {
      localStorage.setItem(DEVTOOLS_MARKER_KEY, 'enabled')
    } catch {}
  }

  resolveBooleanEvaluation(
    flagKey: string,
    _defaultValue: boolean,
    _context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<boolean> {
    return resolveOverride<boolean>(flagKey, ['BOOLEAN'])
  }

  resolveStringEvaluation(
    flagKey: string,
    _defaultValue: string,
    _context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<string> {
    return resolveOverride<string>(flagKey, ['STRING'])
  }

  resolveNumberEvaluation(
    flagKey: string,
    _defaultValue: number,
    _context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<number> {
    return resolveOverride<number>(flagKey, ['INTEGER', 'NUMERIC'])
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    _defaultValue: T,
    _context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<T> {
    return resolveOverride<T>(flagKey, ['JSON'])
  }
}
