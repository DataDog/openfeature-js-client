import {
  NumericComparator,
  Reason,
  Sha256StringComparator,
  StringComparator,
  VariationType,
  VersionComparator,
} from '../configuration/generated/ufc_pb'
import {
  UFC_NUMERIC_COMPARATOR,
  UFC_REASON,
  UFC_SHA256_STRING_COMPARATOR,
  UFC_STRING_COMPARATOR,
  UFC_VARIATION_TYPE,
  UFC_VERSION_COMPARATOR,
} from './ufc-enums'

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

  it('stays aligned with the generated protobuf comparators', () => {
    expect(UFC_NUMERIC_COMPARATOR).toEqual({
      LESS_THAN: NumericComparator.LESS_THAN,
      LESS_THAN_OR_EQUAL: NumericComparator.LESS_THAN_OR_EQUAL,
      GREATER_THAN: NumericComparator.GREATER_THAN,
      GREATER_THAN_OR_EQUAL: NumericComparator.GREATER_THAN_OR_EQUAL,
    })
    expect(UFC_STRING_COMPARATOR).toEqual({
      STARTS_WITH: StringComparator.STARTS_WITH,
      ENDS_WITH: StringComparator.ENDS_WITH,
      CONTAINS: StringComparator.CONTAINS,
    })
    expect(UFC_SHA256_STRING_COMPARATOR).toEqual({
      STARTS_WITH: Sha256StringComparator.STARTS_WITH,
      ENDS_WITH: Sha256StringComparator.ENDS_WITH,
    })
    expect(UFC_VERSION_COMPARATOR).toEqual({
      EQUAL: VersionComparator.EQUAL,
      NOT_EQUAL: VersionComparator.NOT_EQUAL,
      LESS_THAN: VersionComparator.LESS_THAN,
      LESS_THAN_OR_EQUAL: VersionComparator.LESS_THAN_OR_EQUAL,
      GREATER_THAN: VersionComparator.GREATER_THAN,
      GREATER_THAN_OR_EQUAL: VersionComparator.GREATER_THAN_OR_EQUAL,
    })
  })
})
