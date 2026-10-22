import fs from 'node:fs'
import path from 'node:path'
import {
  type CanonicalFlagSelection,
  canonicalizeFlagSelection,
  type FlagSelectionError,
} from '../../src/configuration/flag-selection'

// Format: ffe-system-test-data flag-selection/README.md
interface SelectionVectorCase {
  name: string
  query?: { selected_flag_tags?: string[]; selected_flag_key_patterns?: string[] }
  rawQuery?: string
  sdk?: { selection: CanonicalFlagSelection; dropped?: never } | { dropped: FlagSelectionError; selection?: never }
}

const vectorsPath = path.join(__dirname, '../ffe-system-test-data/flag-selection/selection-vectors.json')
const { cases } = JSON.parse(fs.readFileSync(vectorsPath, 'utf8')) as { cases: SelectionVectorCase[] }

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
