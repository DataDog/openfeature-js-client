import type { ErrorCode, EvaluationContext, JsonValue, Logger } from '@openfeature/core'
import { resolveProtobufAssignment } from '../evaluation/evaluateProtobufConfiguration'
import { type ExperimentationOptOutModeValue, experimentationOptOutPolicy } from '../evaluation/experimentation-opt-out'
import { timeStampNow } from '../time'
import type { FlagsConfiguration, PrecomputedFlag } from './configuration'
import type { PreparedRulesResponse } from './prepared-rules-response'

export type ConfigurationPrecomputeErrorCode = 'invalid_configuration' | 'invalid_context' | 'invalid_options'

/** A top-level input error. Individual flag failures are reported separately. */
export class ConfigurationPrecomputeError extends Error {
  readonly code: ConfigurationPrecomputeErrorCode

  constructor(code: ConfigurationPrecomputeErrorCode) {
    const messages = {
      invalid_configuration: 'Precomputation requires a parsed rules-based configuration',
      invalid_context: 'Precomputation requires a JSON-compatible evaluation context and valid opt-out timestamp',
      invalid_options: 'Invalid precomputation options',
    }
    super(messages[code])
    this.name = 'ConfigurationPrecomputeError'
    this.code = code
  }
}

export type PrecomputeEvaluationError = {
  flagKey: string
  errorCode: ErrorCode
}

export type PrecomputeConfigurationOptions = {
  /** Defaults to disabled. The receiving provider must use the same effective opt-out policy. */
  experimentationOptOutMode?: ExperimentationOptOutModeValue
  /**
   * Called for each omitted evaluation error, after all flags have been evaluated.
   * Contains no context, values, or raw error messages. Exceptions from this callback propagate.
   */
  onEvaluationError?: (error: PrecomputeEvaluationError) => void
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Locally resolve rules for one context, without defaults, tracking, or network calls.
 * Returns a context-bound, precomputed-only snapshot. Failed and unassigned flags are omitted.
 * Recompute when the context or rules change; client-directed output requires client-safe source rules.
 */
export function precomputeConfiguration(
  configuration: FlagsConfiguration,
  context: EvaluationContext,
  options: PrecomputeConfigurationOptions = {}
): FlagsConfiguration {
  const rules = validateRules(configuration)
  const { experimentationOptOutMode, onEvaluationError } = validateOptions(options)
  const snapshotContext = snapshotEvaluationContext(context)
  const optOut = experimentationOptOutPolicy(snapshotContext, experimentationOptOutMode)
  if (optOut === undefined) throw new ConfigurationPrecomputeError('invalid_context')

  const now = timeStampNow()
  const observeFullEvaluationData = rules.observeFullEvaluationData === true
  const environment = { name: rules.environmentName }
  const flags: Array<[string, PrecomputedFlag]> = []
  const errors: PrecomputeEvaluationError[] = []
  for (const flagKey of Object.keys(rules.flags)) {
    const result = resolveProtobufAssignment(rules, flagKey, snapshotContext, NOOP_LOGGER, now, optOut)
    if (result.kind === 'error') {
      errors.push({ flagKey, errorCode: result.errorCode })
    } else if (result.kind === 'assignment') {
      try {
        // Detach cached JSON values and feature destinations from the source configuration.
        flags.push([flagKey, cloneJson(result.assignment) as PrecomputedFlag])
      } catch {
        errors.push({ flagKey, errorCode: 'PARSE_ERROR' as ErrorCode })
      }
    }
  }

  const precomputed: FlagsConfiguration = {
    precomputed: {
      context: snapshotContext,
      fetchedAt: now,
      response: {
        data: {
          attributes: {
            createdAt: new Date(now).toISOString(),
            format: 'PRECOMPUTED',
            obfuscated: false,
            environment,
            observeFullEvaluationData,
            ...(optOut
              ? {
                  evaluation_options:
                    optOut.mode === 'immediate'
                      ? { experimentation_opt_out: true }
                      : {
                          experimentation_opt_out_mode: optOut.mode,
                          dd_experimentation_opt_out_at:
                            new Date(optOut.cutoff.seconds * 1000).toISOString().slice(0, 19) +
                            (optOut.cutoff.fraction ? `.${optOut.cutoff.fraction}` : '') +
                            'Z',
                        },
                }
              : {}),
            flags: Object.fromEntries(flags),
          },
        },
      },
    },
  }
  // User diagnostics cannot change the source or context partway through evaluation.
  for (const error of errors) onEvaluationError?.(error)
  return precomputed
}

function validateRules(configuration: FlagsConfiguration): PreparedRulesResponse {
  try {
    const rules = configuration.rules?.response
    if (
      rules?.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration' &&
      isPlainRecord(rules.flags) &&
      typeof rules.environmentName === 'string' &&
      [rules.attributes, rules.strings, rules.regexes, rules.versions, rules.jsonStrings, rules.conditions].every(
        Array.isArray
      ) &&
      rules.randomizationActivations instanceof Map &&
      rules.evaluationRegexCache instanceof Map &&
      rules.evaluationJsonCache instanceof Map
    )
      return rules
  } catch {
    // Keep malformed input and accessor failures out of diagnostics.
  }
  throw new ConfigurationPrecomputeError('invalid_configuration')
}

function validateOptions(options: PrecomputeConfigurationOptions): PrecomputeConfigurationOptions {
  try {
    if (isPlainRecord(options)) {
      const { experimentationOptOutMode = 'disabled', onEvaluationError } = options
      if (
        ['disabled', 'immediate', 'future_experiments_only'].includes(experimentationOptOutMode) &&
        (onEvaluationError === undefined || typeof onEvaluationError === 'function')
      )
        return { experimentationOptOutMode, onEvaluationError }
    }
  } catch {
    // Do not expose values from malformed options.
  }
  throw new ConfigurationPrecomputeError('invalid_options')
}

function snapshotEvaluationContext(context: EvaluationContext): EvaluationContext {
  try {
    if (isPlainRecord(context)) {
      const snapshot = cloneJson(context) as EvaluationContext
      if (snapshot.targetingKey === undefined || typeof snapshot.targetingKey === 'string') return snapshot
    }
  } catch {
    // Context values can contain PII. Only expose the error category.
  }
  throw new ConfigurationPrecomputeError('invalid_context')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function cloneJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new Error('Invalid JSON value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, (entry) => cloneJson(entry, ancestors))
    if (isPlainRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry, ancestors)]))
    }
    throw new Error('Invalid JSON value')
  } finally {
    ancestors.delete(value)
  }
}
