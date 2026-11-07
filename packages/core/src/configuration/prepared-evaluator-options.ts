export const DEFAULT_MAX_DEPENDENCY_DEPTH = 10

export type PreparedEvaluatorOptions = {
  readonly maxDependencyDepth: number
}

/**
 * Normalize evaluator options when a UFC snapshot is received. The canonical value is
 * retained on the configuration itself so evaluation and later serialization consume
 * the same well-formed metadata.
 */
export function prepareEvaluatorOptions(configuration: object, protobuf: boolean): PreparedEvaluatorOptions {
  const { maxDependencyDepth, invalid } = resolveEvaluatorOptions(configuration, protobuf)
  if (invalid) {
    persistEvaluatorOptions(configuration, protobuf, maxDependencyDepth)
    console.error('invalid evaluatorParams; using default maxDependencyDepth', {
      defaultMaxDependencyDepth: DEFAULT_MAX_DEPENDENCY_DEPTH,
    })
  }
  return { maxDependencyDepth }
}

function resolveEvaluatorOptions(
  configuration: object,
  protobuf: boolean
): PreparedEvaluatorOptions & { invalid: boolean } {
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

function persistEvaluatorOptions(configuration: object, protobuf: boolean, maxDependencyDepth: number): void {
  const target = configuration as { evaluatorParams?: unknown }
  try {
    const existing = target.evaluatorParams
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      ;(existing as { maxDependencyDepth?: unknown }).maxDependencyDepth = protobuf
        ? BigInt(maxDependencyDepth)
        : maxDependencyDepth
      return
    }
    target.evaluatorParams = protobuf
      ? {
          $typeName: 'datadog.ffe.flagging.ufc.v1.EvaluatorParams',
          maxDependencyDepth: BigInt(maxDependencyDepth),
        }
      : { maxDependencyDepth }
  } catch {
    // Malformed, accessor-backed, or frozen low-level inputs still evaluate with the
    // resolved default. Normal decoded UFC snapshots are mutable and persist it.
  }
}

function validEvaluatorOptions(maxDependencyDepth: number): PreparedEvaluatorOptions & { invalid: false } {
  return { maxDependencyDepth, invalid: false }
}

function invalidEvaluatorOptions(): PreparedEvaluatorOptions & { invalid: true } {
  return { maxDependencyDepth: DEFAULT_MAX_DEPENDENCY_DEPTH, invalid: true }
}
