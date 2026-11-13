import type { ErrorCode, EvaluationContext, JsonValue, Logger } from '@openfeature/core'
import { DependencyGraphError } from '../evaluation/errors'
import { resolveProtobufAssignment } from '../evaluation/evaluateProtobufConfiguration'
import {
  createProtobufDependencyResolver,
  type DependencyEvaluation,
  type DependencyExposureCandidate,
} from '../evaluation/evaluation'
import { type ExperimentationOptOutModeValue, experimentationOptOutPolicy } from '../evaluation/experimentation-opt-out'
import { timeStampNow } from '../time'
import type {
  FlagsConfiguration,
  PrecomputedDependencyEvaluation,
  PrecomputedErrorFlag,
  PrecomputedFlag,
} from './configuration'
import { createDependencyFlagKeyEncryptor } from './dependency-key-encryption'
import { encodePrecomputedFlagKey, type FlagKeyObfuscation, readFlagKeyObfuscation } from './flag-key-obfuscation'
import { canonicalizeFlagSelection, type FlagSelection } from './flag-selection'
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
  /**
   * Include only assignments whose whole key matches any pattern; only `*` is special.
   * Tags are unsupported: any defined tags value, including [] or null, throws invalid_options.
   * Malformed or over-limit selections also throw invalid_options. With tags absent, omitted selections or no
   * nonempty keyPatterns include all assignments; a null selection is treated as absent at runtime.
   * Dependencies can use any flag in the source rules.
   */
  flagSelection?: Pick<FlagSelection, 'keyPatterns'> & { tags?: never }
  /** Defaults to disabled. The receiving provider must use the same effective opt-out policy. */
  experimentationOptOutMode?: ExperimentationOptOutModeValue
  /** Encode top-level keys and encrypt root-relative prerequisite keys using this descriptor. */
  obfuscation?: FlagKeyObfuscation
  /**
   * Called for each retained evaluation error, after all flags have been evaluated.
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
 * Returns a context-bound, precomputed-only snapshot. Failures are separated from successful assignments;
 * no-assignment flags remain absent.
 * Recompute when the context or rules change; client-directed output requires client-safe source rules.
 */
export function precomputeConfiguration(
  configuration: FlagsConfiguration,
  context: EvaluationContext,
  options: PrecomputeConfigurationOptions = {}
): FlagsConfiguration {
  const rules = validateRules(configuration)
  const { experimentationOptOutMode, obfuscation, onEvaluationError, keyPatterns } = validateOptions(options)
  const patterns = keyPatterns?.map((pattern) => pattern.split('*'))
  const snapshotContext = snapshotEvaluationContext(context)
  const optOut = experimentationOptOutPolicy(snapshotContext, experimentationOptOutMode)
  if (optOut === undefined) throw new ConfigurationPrecomputeError('invalid_context')

  const now = timeStampNow()
  const observeFullEvaluationData = rules.observeFullEvaluationData === true
  const environment = { name: rules.environmentName }
  const flags: Array<[string, PrecomputedFlag]> = []
  const flagEvaluationErrors: Array<[string, PrecomputedErrorFlag]> = []
  const errors: PrecomputeEvaluationError[] = []
  const selectedFlagKeys = Object.keys(rules.flags).filter(
    (flagKey) => !patterns || patterns.some((parts) => matchesKeyPattern(flagKey, parts))
  )
  for (const flagKey of selectedFlagKeys) {
    const dependencies = createProtobufDependencyResolver(
      rules,
      flagKey,
      snapshotContext,
      NOOP_LOGGER,
      now,
      optOut,
      observeFullEvaluationData,
      true,
      true
    )
    let result: ReturnType<typeof resolveProtobufAssignment>
    try {
      result = resolveProtobufAssignment(
        rules,
        flagKey,
        snapshotContext,
        NOOP_LOGGER,
        now,
        optOut,
        undefined,
        dependencies.resolve
      )
    } catch (error) {
      const errorCode = error instanceof DependencyGraphError ? error.rootErrorCode : ('GENERAL' as ErrorCode)
      const errorMessage = error instanceof DependencyGraphError ? error.rootErrorMessage : undefined
      const trace = dependencies.complete({ value: false, reason: 'ERROR', errorCode, errorMessage })
      const failure = precomputedError(errorCode, errorMessage, trace.dependencyEvaluations, trace.dependencyExposures)
      flagEvaluationErrors.push([flagKey, failure])
      errors.push({ flagKey, errorCode })
      continue
    }
    if (result.kind === 'error') {
      const trace = dependencies.complete({
        value: false,
        reason: 'ERROR',
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      })
      flagEvaluationErrors.push([
        flagKey,
        precomputedError(result.errorCode, result.errorMessage, trace.dependencyEvaluations, trace.dependencyExposures),
      ])
      errors.push({ flagKey, errorCode: result.errorCode })
    } else if (result.kind === 'assignment') {
      const trace = dependencies.complete({
        value: result.assignment.variationValue,
        variant: result.assignment.variationKey,
        reason: result.assignment.reason,
      })
      try {
        const { features, ...assignment } = result.assignment
        const dependencyEvaluations = toPrecomputedDependencyEvaluations(
          trace.dependencyEvaluations,
          trace.dependencyExposures
        )
        const copy = cloneJson({
          ...assignment,
          ...(dependencyEvaluations.length === 0 ? {} : { dependencyEvaluations }),
        }) as PrecomputedFlag
        if (Array.isArray(features)) {
          // Optional feature metadata must not discard an otherwise valid assignment.
          const portableFeatures = features.flatMap((feature) => {
            try {
              return [cloneJson(feature)]
            } catch {
              return []
            }
          })
          if (portableFeatures.length > 0) copy.features = portableFeatures
        }
        flags.push([flagKey, copy])
      } catch {
        flagEvaluationErrors.push([
          flagKey,
          precomputedError('PARSE_ERROR' as ErrorCode, undefined, trace.dependencyEvaluations, []),
        ])
        errors.push({ flagKey, errorCode: 'PARSE_ERROR' as ErrorCode })
      }
    }
  }

  reconcileDependencySerializationFailures(flags, flagEvaluationErrors, errors, new Set(selectedFlagKeys))
  const encoded = encodePrecomputedResults(flags, flagEvaluationErrors, obfuscation)

  const precomputed: FlagsConfiguration = {
    precomputed: {
      context: snapshotContext,
      fetchedAt: now,
      response: {
        data: {
          attributes: {
            createdAt: new Date(now).toISOString(),
            format: 'PRECOMPUTED',
            ...(obfuscation ? { obfuscated: true, obfuscation } : { obfuscated: false }),
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
            flags: encoded.flags,
            ...(Object.keys(encoded.flagEvaluationErrors).length === 0
              ? {}
              : { flagEvaluationErrors: encoded.flagEvaluationErrors }),
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

function validateOptions(
  options: PrecomputeConfigurationOptions
): Omit<PrecomputeConfigurationOptions, 'flagSelection'> & { keyPatterns?: readonly string[] } {
  try {
    if (isPlainRecord(options)) {
      const { experimentationOptOutMode = 'disabled', obfuscation, onEvaluationError, flagSelection } = options
      if (flagSelection?.tags !== undefined) throw new ConfigurationPrecomputeError('invalid_options')
      const { selection, error } = canonicalizeFlagSelection(flagSelection)
      const parsedEncoding = obfuscation === undefined ? {} : readFlagKeyObfuscation(true, obfuscation)
      const encoding = 'error' in parsedEncoding ? undefined : parsedEncoding.encoding
      if (
        ['disabled', 'immediate', 'future_experiments_only'].includes(experimentationOptOutMode) &&
        (obfuscation === undefined || encoding !== undefined) &&
        (onEvaluationError === undefined || typeof onEvaluationError === 'function') &&
        !error
      )
        return {
          experimentationOptOutMode,
          obfuscation: encoding && { scheme: encoding.scheme, salt: encoding.salt },
          onEvaluationError,
          keyPatterns: selection?.keyPatterns,
        }
    }
  } catch {
    // Do not expose values from malformed options.
  }
  throw new ConfigurationPrecomputeError('invalid_options')
}

function precomputedError(
  errorCode: ErrorCode,
  errorMessage: string | undefined,
  evaluations: readonly DependencyEvaluation[],
  exposures: readonly DependencyExposureCandidate[]
): PrecomputedErrorFlag {
  const dependencyEvaluations = toPrecomputedDependencyEvaluations(evaluations, exposures)
  return {
    reason: 'ERROR',
    errorCode,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(dependencyEvaluations.length === 0 ? {} : { dependencyEvaluations }),
  }
}

function toPrecomputedDependencyEvaluations(
  evaluations: readonly DependencyEvaluation[],
  exposures: readonly DependencyExposureCandidate[]
): PrecomputedDependencyEvaluation[] {
  const present = new Set(exposures.map(({ flagKey }) => flagKey))
  return evaluations.map(({ flagKey, details }) =>
    details.reason === 'ERROR' || details.errorCode !== undefined
      ? {
          flagKey,
          reason: 'ERROR',
          errorCode: details.errorCode ?? ('GENERAL' as ErrorCode),
          ...(details.errorMessage === undefined ? {} : { errorMessage: details.errorMessage }),
        }
      : { flagKey, isPresentInAssignment: present.has(flagKey) }
  )
}

function reconcileDependencySerializationFailures(
  flags: Array<[string, PrecomputedFlag]>,
  flagEvaluationErrors: Array<[string, PrecomputedErrorFlag]>,
  errors: PrecomputeEvaluationError[],
  selectedKeys: ReadonlySet<string>
): void {
  const successfulKeys = new Set(flags.map(([flagKey]) => flagKey))
  const failures = new Map(flagEvaluationErrors)
  let changed = true
  while (changed) {
    changed = false
    for (let index = flags.length - 1; index >= 0; index--) {
      const [rootKey, flag] = flags[index]
      const missingDependencies = flag.dependencyEvaluations?.filter(
        (dependency) =>
          'isPresentInAssignment' in dependency &&
          selectedKeys.has(dependency.flagKey) &&
          !successfulKeys.has(dependency.flagKey)
      )
      if (!missingDependencies?.length) continue

      const dependencyEvaluations = flag.dependencyEvaluations?.map((dependency) =>
        'isPresentInAssignment' in dependency &&
        selectedKeys.has(dependency.flagKey) &&
        !successfulKeys.has(dependency.flagKey)
          ? dependencySerializationError(dependency.flagKey, failures.get(dependency.flagKey))
          : 'isPresentInAssignment' in dependency
            ? { ...dependency, isPresentInAssignment: false }
            : dependency
      )
      const failure: PrecomputedErrorFlag = {
        reason: 'ERROR',
        errorCode: 'GENERAL' as ErrorCode,
        errorMessage: 'Dependency has no serializable assignment',
        ...(dependencyEvaluations?.length ? { dependencyEvaluations } : {}),
      }
      flags.splice(index, 1)
      successfulKeys.delete(rootKey)
      flagEvaluationErrors.push([rootKey, failure])
      failures.set(rootKey, failure)
      errors.push({ flagKey: rootKey, errorCode: 'GENERAL' as ErrorCode })
      changed = true
    }
  }

  for (const [, flag] of flags) {
    if (!flag.dependencyEvaluations) continue
    flag.dependencyEvaluations = flag.dependencyEvaluations.map((dependency) =>
      'isPresentInAssignment' in dependency && !selectedKeys.has(dependency.flagKey)
        ? { ...dependency, isPresentInAssignment: false }
        : dependency
    )
  }

  // Reconcile every failed root against the final assignment set. A root can be
  // demoted before one of its transitive dependencies, so normalizing only at
  // demotion time would leave an order-dependent successful dependency entry.
  for (const [, failure] of flagEvaluationErrors) {
    if (!failure.dependencyEvaluations) continue
    failure.dependencyEvaluations = failure.dependencyEvaluations.map((dependency) =>
      'isPresentInAssignment' in dependency &&
      selectedKeys.has(dependency.flagKey) &&
      !successfulKeys.has(dependency.flagKey)
        ? dependencySerializationError(dependency.flagKey, failures.get(dependency.flagKey))
        : 'isPresentInAssignment' in dependency
          ? { ...dependency, isPresentInAssignment: false }
          : dependency
    )
  }
}

function dependencySerializationError(
  flagKey: string,
  failure: PrecomputedErrorFlag | undefined
): PrecomputedDependencyEvaluation {
  return {
    flagKey,
    reason: 'ERROR',
    errorCode: failure?.errorCode ?? ('PARSE_ERROR' as ErrorCode),
    ...(failure?.errorMessage === undefined ? {} : { errorMessage: failure.errorMessage }),
  }
}

function encodePrecomputedResults(
  flags: Array<[string, PrecomputedFlag]>,
  errors: Array<[string, PrecomputedErrorFlag]>,
  obfuscation: FlagKeyObfuscation | undefined
): { flags: Record<string, PrecomputedFlag>; flagEvaluationErrors: Record<string, PrecomputedErrorFlag> } {
  if (!obfuscation) {
    return { flags: Object.fromEntries(flags), flagEvaluationErrors: Object.fromEntries(errors) }
  }
  return {
    flags: Object.fromEntries(
      flags.map(([rootKey, flag]) => [
        encodeRootKey(rootKey, obfuscation),
        encodeDependencies(rootKey, flag, obfuscation),
      ])
    ),
    flagEvaluationErrors: Object.fromEntries(
      errors.map(([rootKey, error]) => [
        encodeRootKey(rootKey, obfuscation),
        encodeDependencies(rootKey, error, obfuscation),
      ])
    ),
  }
}

function encodeRootKey(rootKey: string, obfuscation: FlagKeyObfuscation): string {
  const encoded = encodePrecomputedFlagKey(rootKey, obfuscation)
  if ('error' in encoded) throw new ConfigurationPrecomputeError('invalid_configuration')
  return encoded.key
}

function encodeDependencies<T extends PrecomputedFlag | PrecomputedErrorFlag>(
  rootKey: string,
  result: T,
  obfuscation: FlagKeyObfuscation
): T {
  const encoded: PrecomputedFlag | PrecomputedErrorFlag = { ...result }
  // Diagnostic text is optional and may contain plaintext flag keys supplied by
  // the evaluator. Obfuscated packets retain structured error codes only.
  if ('errorMessage' in encoded) delete encoded.errorMessage
  if (result.dependencyEvaluations) {
    const encryptDependencyFlagKey = createDependencyFlagKeyEncryptor(rootKey, obfuscation)
    encoded.dependencyEvaluations = result.dependencyEvaluations.map((dependency) => {
      const encodedDependency = {
        ...dependency,
        flagKey: encryptDependencyFlagKey(dependency.flagKey),
      }
      if ('errorMessage' in encodedDependency) delete encodedDependency.errorMessage
      return encodedDependency
    })
  }
  return encoded as T
}

/** Match literal segments in order, anchored at both ends, without interpreting regex syntax. */
function matchesKeyPattern(key: string, parts: readonly string[]): boolean {
  if (parts.length === 1) return key === parts[0]
  if (!key.startsWith(parts[0])) return false
  let offset = parts[0].length
  for (let index = 1; index < parts.length - 1; index++) {
    const position = key.indexOf(parts[index], offset)
    if (position === -1) return false
    offset = position + parts[index].length
  }
  const last = parts[parts.length - 1]
  return key.endsWith(last) && key.length - last.length >= offset
}

function snapshotEvaluationContext(context: EvaluationContext): EvaluationContext {
  try {
    if (isPlainRecord(context)) {
      const targetingContext = Object.fromEntries(
        Object.entries(context).filter(([key]) => key !== 'dd_assignment_token')
      )
      const snapshot = cloneJson(targetingContext) as EvaluationContext
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
