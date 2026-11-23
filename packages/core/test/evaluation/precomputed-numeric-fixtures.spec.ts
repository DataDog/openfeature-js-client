import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'lossless-json'
import {
  configurationFromPrecomputedString as configurationFromString,
  configurationToPrecomputedString as configurationToString,
} from '../../src/configuration/precomputed-wire'
import { evaluatePrecomputedConfiguration } from '../../src/evaluation/precomputed-evaluation'

type PlatformFilter = Array<{ platform: string }>
type Fixture = {
  context: { targetingKey: string; attributes: Record<string, string> }
  evaluations: Array<{
    flag: string
    defaultValue: number
    _include?: PlatformFilter
    _skip?: PlatformFilter
    expectedResult: { value: number; reason: string; errorCode: string | null; variantKey: string | null }
  }>
}

// Read the shared decimal fixtures verbatim and apply their evaluation filters:
// native-only Integer getters do not apply to JavaScript's Number getter.
describe.each(['float', 'integer', 'number'])('shared numeric-decimal-%s', (label) => {
  const file = path.resolve(
    __dirname,
    `../ffe-system-test-data/precomputed-assignments/cases/evaluator/numeric-decimal-${label}.json`
  )
  const text = fs.readFileSync(file, 'utf8')
  const fixture = JSON.parse(text) as Fixture
  // Preserve the response's numeric tokens, not JSON.parse's rounded values.
  const exact = parse(text) as { response: unknown }
  const response = stringify(exact.response)!
  const context = { targetingKey: fixture.context.targetingKey, ...fixture.context.attributes }
  const configuration = configurationFromString(JSON.stringify({ version: 1, precomputed: { context, response } }))
  const restored = configurationFromString(configurationToString(configuration))
  const evaluations = fixture.evaluations.filter(
    (evaluation) =>
      (!evaluation._include || evaluation._include.some(({ platform }) => platform === 'web')) &&
      !evaluation._skip?.some(({ platform }) => platform === 'web')
  )

  it.each(evaluations)('$flag', (evaluation) => {
    for (const snapshot of [configuration, restored]) {
      const details = evaluatePrecomputedConfiguration(
        snapshot,
        'number',
        evaluation.flag,
        evaluation.defaultValue,
        context
      )
      expect({
        value: details.value,
        reason: details.reason,
        errorCode: details.errorCode ?? null,
        variantKey: details.variant ?? null,
      }).toEqual(evaluation.expectedResult)
    }
  })
})
