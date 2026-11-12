import fs from 'node:fs'
import path from 'node:path'
import { fromJson } from '@bufbuild/protobuf'
import {
  type CanonicalFlagSelection,
  canonicalizeFlagSelection,
  type FlagSelectionError,
} from '../../src/configuration/flag-selection'
import { FlagsConfigurationSchema } from '../../src/configuration/generated/ufc_pb'
import { precomputeConfiguration } from '../../src/configuration/precompute-configuration'
import { configurationFromRulesBinary } from '../../src/configuration/rules-wire'
import { encodeFlagsConfiguration } from '../../src/configuration/ufc-protobuf'

// Format: ffe-system-test-data flag-selection/README.md
interface SelectionVectorCase {
  name: string
  query?: { selected_flag_tags?: string[]; selected_flag_key_patterns?: string[] }
  rawQuery?: string
  sdk?: { selection: CanonicalFlagSelection; dropped?: never } | { dropped: FlagSelectionError; selection?: never }
  expected: { outcome: 'applied'; selectedKeys: string[] } | { outcome: 'ignored'; reason: string }
}

// Keep the selection PR's fixtures separate until they merge with the main evaluator fixtures.
// Source: https://github.com/DataDog/ffe-system-test-data/pull/50
const vectorsPath = path.join(__dirname, '../ffe-flag-selection-data/flag-selection/selection-vectors.json')
const { flags, cases } = JSON.parse(fs.readFileSync(vectorsPath, 'utf8')) as {
  flags: { key: string }[]
  cases: SelectionVectorCase[]
}

describe('flag selection vectors', () => {
  it('has SDK cases to run', () => {
    expect(cases.some((vector) => vector.sdk)).toBe(true)
  })

  describe.each(cases.map((vector) => [vector.name, vector] as const))('%s', (_, vector) => {
    // rawQuery cases exercise server-side percent-decoding and carry no SDK expectation.
    const runSdkCase = vector.sdk ? it : it.skip

    runSdkCase('matches the SDK expectation', () => {
      const { sdk, query = {} } = vector
      const result = canonicalizeFlagSelection({
        tags: query.selected_flag_tags,
        keyPatterns: query.selected_flag_key_patterns,
      })

      if (sdk?.dropped) {
        expect(result).toEqual({ error: sdk.dropped })
      } else if (sdk?.selection.tags.length === 0 && sdk.selection.keyPatterns.length === 0) {
        expect(result).toEqual({})
      } else {
        expect(result).toEqual({ selection: sdk?.selection })
      }
    })
  })
})

describe('local precomputation flag selection vectors', () => {
  // Tags and raw queries cannot be expressed locally. Invalid selections are tested separately:
  // local precomputation throws invalid_options instead of using the server's full-config fallback.
  const matchingCases = cases.filter(
    (vector) =>
      vector.sdk?.selection && !vector.query?.selected_flag_tags?.length && vector.expected.outcome === 'applied'
  )
  const rules = configurationFromRulesBinary(
    encodeFlagsConfiguration(
      fromJson(FlagsConfigurationSchema, {
        environmentName: 'test',
        strings: ['on'],
        flags: Object.fromEntries(
          flags.map(({ key }) => [
            key,
            {
              variationType: 'VARIATION_TYPE_BOOLEAN',
              variations: [{ keyStringIndex: 0, booleanValue: true }],
              allocations: [{ key: 'allocation', splits: [{ variationIndex: 0, reason: 'REASON_STATIC' }] }],
            },
          ])
        ),
      })
    )
  )

  it('has shared key-pattern matching cases to run', () => {
    expect(matchingCases.length).toBeGreaterThan(0)
  })

  it.each(matchingCases.map((vector) => [vector.name, vector] as const))('%s', (_, vector) => {
    const result = precomputeConfiguration(
      rules,
      {},
      {
        flagSelection: { keyPatterns: vector.query?.selected_flag_key_patterns },
      }
    )
    if (vector.expected.outcome !== 'applied') throw new Error('Expected an applied selection vector')
    expect(Object.keys(result.precomputed!.response.data.attributes.flags).sort()).toEqual(
      vector.expected.selectedKeys.slice().sort()
    )
  })
})
