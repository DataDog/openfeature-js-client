export interface CheckResult {
  name: string
  passed: boolean
  detail: string
}

export interface Report {
  results: CheckResult[]
  elapsedMs: number
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// Keep the SDK requires inside the runner so module-initialization exceptions
// become visible failures on screen. Metro still resolves these static specifiers.
export function runChecks(runtime: { hermes: boolean; platform: string }): Report {
  const started = performance.now()
  const results: CheckResult[] = []
  const check = (name: string, run: () => string) => {
    try {
      results.push({ name, passed: true, detail: run() })
    } catch (error) {
      results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  check('Native Hermes runtime', () => {
    expect(runtime.platform === 'ios' || runtime.platform === 'android', `Not a native platform: ${runtime.platform}`)
    expect(runtime.hermes, 'Hermes is not active. Open this app in Expo Go on a simulator/emulator or device.')
    return `${runtime.platform} / Hermes (not Node or a browser)`
  })

  try {
    const core: typeof import('@datadog/flagging-core') = require('@datadog/flagging-core')
    const parser: typeof import('@datadog/flagging-core/rules-based') = require('@datadog/flagging-core/rules-based')
    const { rules, precomputed } = require('./configurations')
    results.push({
      name: 'Public package imports',
      passed: true,
      detail: 'Root and /rules-based loaded from the tarball',
    })

    const parseRules = () => parser.configurationFromString(JSON.stringify(rules))
    const parsePrecomputed = () => parser.configurationFromString(JSON.stringify(precomputed))

    check('Protobuf decode and round trip', () => {
      const decoded = parseRules()
      // Decoded protobuf objects contain BigInt; only the SDK serializer should
      // serialize them, including when constructing assertion diagnostics.
      expect(!!decoded.rules?.response, 'Decoder returned no rules response')
      const restored = parser.configurationFromString(parser.configurationToString(decoded))
      expect(!!restored.rules?.response, 'Round trip lost the rules response')
      expect(
        parser.configurationToString(restored) === parser.configurationToString(decoded),
        'Configuration changed after serialization'
      )
      return 'Rules decoded, serialized, and decoded again'
    })

    check('Boolean rule', () => {
      const result = core.evaluateRulesBasedConfiguration(
        parseRules().rules?.response,
        'boolean',
        'browser-flag',
        false,
        {},
        logger
      )
      expect(result.value === true && result.variant === 'on' && result.reason === 'STATIC', JSON.stringify(result))
      return JSON.stringify(result)
    })

    check('Integer rule', () => {
      const result = core.evaluateRulesBasedConfiguration(
        parseRules().rules?.response,
        'number',
        'integer-flag',
        0,
        {},
        logger
      )
      expect(result.value === 42 && result.reason === 'STATIC', JSON.stringify(result))
      return JSON.stringify(result)
    })

    check('Precomputed matching context', () => {
      const result = core.evaluate(
        parsePrecomputed(),
        'boolean',
        'precomputed-flag',
        false,
        precomputed.precomputed.context,
        logger
      )
      expect(result.value === true && result.reason === 'STATIC', JSON.stringify(result))
      return JSON.stringify(result)
    })

    check('Precomputed context mismatch', () => {
      const result = core.evaluate(parsePrecomputed(), 'boolean', 'precomputed-flag', false, {}, logger)
      expect(result.value === false && result.errorCode === 'INVALID_CONTEXT', JSON.stringify(result))
      return JSON.stringify(result)
    })

    check('Mixed configuration rules fallback', () => {
      const mixed = parser.configurationFromString(JSON.stringify({ ...rules, precomputed: precomputed.precomputed }))
      const result = core.evaluate(mixed, 'boolean', 'browser-flag', false, {}, logger)
      expect(result.value === true && result.reason === 'STATIC', JSON.stringify(result))
      return JSON.stringify(result)
    })

    check('Root parser stays precomputed-only', () => {
      const parsed = core.configurationFromString(JSON.stringify({ ...rules, precomputed: precomputed.precomputed }))
      expect(!!parsed.precomputed && !parsed.rules, 'Root parser did not preserve precomputed-only behavior')
      return 'Root parser handles precomputed data without enabling rules parsing'
    })

    check('1,000 repeated evaluations', () => {
      const configuration = parseRules()
      const start = performance.now()
      for (let i = 0; i < 1000; i++) {
        const result = core.evaluateRulesBasedConfiguration(
          configuration.rules?.response,
          'number',
          'integer-flag',
          0,
          {},
          logger
        )
        expect(result.value === 42 && result.reason === 'STATIC', `Iteration ${i}: ${JSON.stringify(result)}`)
      }
      return `1,000 correct evaluations in ${(performance.now() - start).toFixed(1)} ms (informational, not a benchmark)`
    })
  } catch (error) {
    results.push({
      name: 'SDK initialization',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  return { results, elapsedMs: performance.now() - started }
}
