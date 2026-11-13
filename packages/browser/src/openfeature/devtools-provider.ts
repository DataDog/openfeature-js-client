import type {
  EvaluationContext,
  Hook,
  JsonValue,
  Logger,
  Paradigm,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { TypeMismatchError } from '@openfeature/web-sdk'
import {
  createDebugLogger,
  type DebugConfiguration,
  type DebugLogger,
  evaluationDebug,
  getDebugLogger,
  registerDebugLogger,
} from '../debug'
import { inheritEvaluationTelemetryPolicy } from './evaluation-telemetry-policy'
import { registerTransparentProvider } from './exposure-scope'

const OVERRIDES_KEY = 'dd.dd_flag.overrides'
const DEVTOOLS_MARKER_KEY = 'dd.dd_flag.devtools'

// Wrappers in this module share one marker, including during provider replacement.
const markerOwners = new Set<symbol>()

type DDFlagOverrideType = 'BOOLEAN' | 'STRING' | 'INTEGER' | 'NUMERIC' | 'JSON'

interface DDFlagOverride {
  type: DDFlagOverrideType
  value: boolean | string | number | JsonValue
}

function readOverrides(debug: DebugLogger): Record<string, DDFlagOverride> {
  try {
    const parsed = JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, DDFlagOverride>
    }
  } catch (error) {
    debug.event('override.load_failed', () => ({ error, action: 'delegate_to_inner_provider' }))
  }
  return {}
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
  private readonly markerOwner = Symbol()

  private readonly debug: DebugLogger

  constructor(
    private readonly inner: Provider,
    options: DebugConfiguration = {}
  ) {
    this.debug =
      options.debugMode === undefined
        ? getDebugLogger(inner.metadata)
        : createDebugLogger(options.debugMode, 'devtools')
    registerDebugLogger(this.metadata, this.debug)
    inheritEvaluationTelemetryPolicy(this.metadata, inner.metadata)
    registerTransparentProvider(this.metadata, inner.metadata)
  }

  get hooks(): Hook[] | undefined {
    if (!this.debug.enabled || getDebugLogger(this.inner.metadata).enabled) return this.inner.hooks
    return [
      ...(this.inner.hooks ?? []),
      {
        before: (context) =>
          evaluationDebug(context.context, this.debug, 'before').event('evaluation.requested', () => ({ context })),
        finally: (context, details) =>
          evaluationDebug(context.context, this.debug).event('evaluation.returned', () => ({ context, details })),
      },
    ]
  }

  get events() {
    return this.inner.events
  }

  get status() {
    return this.inner.status
  }

  async initialize(context?: EvaluationContext): Promise<void> {
    this.overrides = readOverrides(this.debug)
    this.debug.event('override.loaded', () => ({ overrides: this.overrides, refresh: 'initialize_only' }))
    markerOwners.add(this.markerOwner)
    try {
      localStorage.setItem(DEVTOOLS_MARKER_KEY, 'enabled')
    } catch {}
    await this.inner.initialize?.(context)
  }

  async onClose(): Promise<void> {
    if (markerOwners.delete(this.markerOwner) && markerOwners.size === 0) {
      try {
        localStorage.removeItem(DEVTOOLS_MARKER_KEY)
      } catch {}
    }
    await this.inner.onClose?.()
  }

  onContextChange(oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> | void {
    return this.inner.onContextChange?.(oldContext, newContext)
  }

  private resolveOverride<T>(
    flagKey: string,
    expectedTypes: DDFlagOverrideType[],
    defaultValue: T,
    context: EvaluationContext
  ): ResolutionDetails<T> | null {
    const override = this.overrides[flagKey]
    if (!override || !expectedTypes.includes(override.type)) {
      evaluationDebug(context, this.debug).event('override.decision', () => ({
        flagKey,
        override,
        expectedTypes,
        outcome: 'delegate_to_inner_provider',
      }))
      return null
    }
    const actualType = override.value === null ? 'null' : typeof override.value
    if (override.value === null || actualType !== EXPECTED_JS_TYPES[override.type]) {
      const msg = `[DatadogDevtools] override for '${flagKey}' declares type ${override.type} but value is ${actualType} — override ignored`
      evaluationDebug(context, this.debug).event('override.invalid', () => ({
        flagKey,
        override,
        expectedTypes,
        error: msg,
      }))
      console.warn(msg)
      throw new TypeMismatchError(msg)
    }
    if (override.type === 'INTEGER' && !Number.isInteger(override.value)) {
      const msg = `[DatadogDevtools] override for '${flagKey}' declares type INTEGER but value ${override.value} is not a whole number — override ignored`
      evaluationDebug(context, this.debug).event('override.invalid', () => ({
        flagKey,
        override,
        expectedTypes,
        error: msg,
      }))
      console.warn(msg)
      throw new TypeMismatchError(msg)
    }
    evaluationDebug(context, this.debug, 'resolve').event('evaluation.completed', () => ({
      flagKey,
      requestedContext: context,
      defaultValue,
      requestedType: expectedTypes,
      value: override.value,
      reason: 'STATIC',
      valueOrigin: 'local_override',
      runtimeDefaultUsed: false,
    }))
    return { value: override.value as T, reason: 'STATIC', flagMetadata: { overridden: true } }
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<boolean> {
    return (
      this.resolveOverride<boolean>(flagKey, ['BOOLEAN'], defaultValue, context) ??
      this.inner.resolveBooleanEvaluation(flagKey, defaultValue, context, logger)
    )
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<string> {
    return (
      this.resolveOverride<string>(flagKey, ['STRING'], defaultValue, context) ??
      this.inner.resolveStringEvaluation(flagKey, defaultValue, context, logger)
    )
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<number> {
    return (
      this.resolveOverride<number>(flagKey, ['INTEGER', 'NUMERIC'], defaultValue, context) ??
      this.inner.resolveNumberEvaluation(flagKey, defaultValue, context, logger)
    )
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<T> {
    return (
      this.resolveOverride<T>(flagKey, ['JSON'], defaultValue, context) ??
      this.inner.resolveObjectEvaluation(flagKey, defaultValue, context, logger)
    )
  }
}
