import type { Logger } from '@openfeature/core'
import type { EvaluatorParams as ProtobufEvaluatorParams } from './generated/ufc_pb'

const DEFAULT_MAX_DEPENDENCY_DEPTH = 10
const MAX_MAX_DEPENDENCY_DEPTH = 255

export class EvaluatorParams {
  private constructor(readonly effectiveMaxDependencyDepth: number) {
    Object.freeze(this)
  }

  static fromJson(value: unknown, logger: Pick<Logger, 'warn'>): EvaluatorParams {
    return EvaluatorParams.fromParsed(
      parseSafely(() => parseJsonMaxDependencyDepth(value)),
      logger
    )
  }

  static fromJsonConfiguration(value: unknown, logger: Pick<Logger, 'warn'>): EvaluatorParams {
    return EvaluatorParams.fromParsed(
      parseSafely(() => parseJsonMaxDependencyDepth(readProperty(value, 'evaluatorParams'))),
      logger
    )
  }

  static fromProtobuf(value: ProtobufEvaluatorParams | undefined, logger: Pick<Logger, 'warn'>): EvaluatorParams {
    return EvaluatorParams.fromParsed(
      parseSafely(() => parseProtobufMaxDependencyDepth(value)),
      logger
    )
  }

  static fromProtobufConfiguration(value: unknown, logger: Pick<Logger, 'warn'>): EvaluatorParams {
    return EvaluatorParams.fromParsed(
      parseSafely(() =>
        parseProtobufMaxDependencyDepth(readProperty(value, 'evaluatorParams') as ProtobufEvaluatorParams | undefined)
      ),
      logger
    )
  }

  private static fromParsed(parsed: ParsedMaxDependencyDepth, logger: Pick<Logger, 'warn'>): EvaluatorParams {
    if (parsed.invalid) {
      try {
        logger.warn('Invalid evaluatorParams; using default maxDependencyDepth', {
          defaultMaxDependencyDepth: DEFAULT_MAX_DEPENDENCY_DEPTH,
        })
      } catch {
        // Configuration diagnostics must never prevent configuration loading.
      }
    }
    return new EvaluatorParams(parsed.value)
  }
}

type ParsedMaxDependencyDepth = {
  value: number
  invalid: boolean
}

function parseJsonMaxDependencyDepth(value: unknown): ParsedMaxDependencyDepth {
  if (value === undefined) return defaultDepth(false)
  if (!isRecord(value)) return defaultDepth(true)

  let depth: unknown
  try {
    depth = value.maxDependencyDepth
  } catch {
    return defaultDepth(true)
  }
  if (depth === undefined) return defaultDepth(false)
  return isValidNumberDepth(depth) ? { value: depth, invalid: false } : defaultDepth(true)
}

function parseProtobufMaxDependencyDepth(value: ProtobufEvaluatorParams | undefined): ParsedMaxDependencyDepth {
  if (value === undefined) return defaultDepth(false)
  if (!isRecord(value)) return defaultDepth(true)

  let depth: unknown
  try {
    depth = value.maxDependencyDepth
  } catch {
    return defaultDepth(true)
  }
  if (depth === undefined) return defaultDepth(false)
  if (typeof depth !== 'bigint' || depth < BigInt(0) || depth > BigInt(MAX_MAX_DEPENDENCY_DEPTH)) {
    return defaultDepth(true)
  }
  return { value: Number(depth), invalid: false }
}

function isValidNumberDepth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MAX_DEPENDENCY_DEPTH
}

function defaultDepth(invalid: boolean): ParsedMaxDependencyDepth {
  return { value: DEFAULT_MAX_DEPENDENCY_DEPTH, invalid }
}

function parseSafely(parse: () => ParsedMaxDependencyDepth): ParsedMaxDependencyDepth {
  try {
    return parse()
  } catch {
    return defaultDepth(true)
  }
}

function readProperty(value: unknown, property: string): unknown {
  if (typeof value !== 'object' || value === null) throw new TypeError('configuration must be an object')
  return Reflect.get(value, property)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
