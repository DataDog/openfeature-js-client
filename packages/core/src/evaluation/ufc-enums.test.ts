import { Reason, VariationType } from '../configuration/generated/ufc_pb'
import { UFC_REASON, UFC_VARIATION_TYPE } from './ufc-enums'

describe('UFC enum constants', () => {
  it('stays aligned with the generated protobuf variation types', () => {
    expect(UFC_VARIATION_TYPE).toEqual({
      STRING: VariationType.STRING,
      INTEGER: VariationType.INTEGER,
      NUMERIC: VariationType.NUMERIC,
      BOOLEAN: VariationType.BOOLEAN,
      JSON: VariationType.JSON,
    })
  })

  it('stays aligned with the generated protobuf reasons', () => {
    expect(UFC_REASON).toEqual({
      TARGETING_MATCH: Reason.TARGETING_MATCH,
      SPLIT: Reason.SPLIT,
      STATIC: Reason.STATIC,
      DEFAULT: Reason.DEFAULT,
    })
  })
})
