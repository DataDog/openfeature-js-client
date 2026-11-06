import type { Logger } from '@openfeature/core'

export const DEFAULT_MAX_DEPENDENCY_DEPTH = 10

const PREPARED_EVALUATOR_OPTIONS = Symbol('datadog.prepared-evaluator-options')

export type PreparedEvaluatorOptions = {
  readonly maxDependencyDepth: number
  readonly diagnostic?: 'invalid_evaluator_params'
  diagnosticReported: boolean
}

type ConfigurationWithPreparedEvaluatorOptions = object & {
  [PREPARED_EVALUATOR_OPTIONS]?: PreparedEvaluatorOptions
}

/** Resolve evaluator options once while preparing a received UFC snapshot. */
export function prepareEvaluatorOptions(configuration: object, protobuf: boolean): PreparedEvaluatorOptions {
  const target = configuration as ConfigurationWithPreparedEvaluatorOptions
  try {
    const prepared = target[PREPARED_EVALUATOR_OPTIONS]
    if (prepared) return prepared
  } catch {
    // Resolve malformed or instrumented objects without trusting accessors.
  }

  const prepared = resolveEvaluatorOptions(configuration, protobuf)
  try {
    Object.defineProperty(target, PREPARED_EVALUATOR_OPTIONS, { value: prepared })
  } catch {
    // Non-extensible low-level inputs can still be evaluated with the resolved value.
  }
  return prepared
}

/** Emit a prepared configuration diagnostic once for the ordinary evaluator consumer. */
export function reportEvaluatorOptionsDiagnostic(
  options: PreparedEvaluatorOptions,
  logger: Logger,
  rootFlagKey: string
): void {
  if (options.diagnostic !== 'invalid_evaluator_params' || options.diagnosticReported) return
  options.diagnosticReported = true
  logger.error('invalid evaluatorParams; using default maxDependencyDepth', {
    flagKey: rootFlagKey,
    defaultMaxDependencyDepth: DEFAULT_MAX_DEPENDENCY_DEPTH,
  })
}

function resolveEvaluatorOptions(configuration: object, protobuf: boolean): PreparedEvaluatorOptions {
  let evaluatorParams: unknown
  try {
    evaluatorParams = (configuration as { evaluatorParams?: unknown }).evaluatorParams
  } catch {
    return invalidEvaluatorOptions()
  }
  if (evaluatorParams === undefined) return validEvaluatorOptions(DEFAULT_MAX_DEPENDENCY_DEPTH)
  if (evaluatorParams === null || typeof evaluatorParams !== 'object' || Array.isArray(evaluatorParams)) {
    return invalidEvaluatorOptions()
  }

  let configuredDepth: unknown
  try {
    configuredDepth = (evaluatorParams as { maxDependencyDepth?: unknown }).maxDependencyDepth
  } catch {
    return invalidEvaluatorOptions()
  }
  if (configuredDepth === undefined) return validEvaluatorOptions(DEFAULT_MAX_DEPENDENCY_DEPTH)
  const numericDepth = typeof configuredDepth === 'bigint' && protobuf ? Number(configuredDepth) : configuredDepth
  return typeof numericDepth === 'number' && Number.isInteger(numericDepth) && numericDepth >= 0 && numericDepth <= 255
    ? validEvaluatorOptions(numericDepth)
    : invalidEvaluatorOptions()
}

function validEvaluatorOptions(maxDependencyDepth: number): PreparedEvaluatorOptions {
  return { maxDependencyDepth, diagnosticReported: false }
}

function invalidEvaluatorOptions(): PreparedEvaluatorOptions {
  return {
    maxDependencyDepth: DEFAULT_MAX_DEPENDENCY_DEPTH,
    diagnostic: 'invalid_evaluator_params',
    diagnosticReported: false,
  }
}
