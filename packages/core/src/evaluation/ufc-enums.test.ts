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
    expect(UFC_VARIATION_TYPE.STRING).toBe(VariationType.STRING)
    expect(UFC_VARIATION_TYPE.INTEGER).toBe(VariationType.INTEGER)
    expect(UFC_VARIATION_TYPE.NUMERIC).toBe(VariationType.NUMERIC)
    expect(UFC_VARIATION_TYPE.BOOLEAN).toBe(VariationType.BOOLEAN)
    expect(UFC_VARIATION_TYPE.JSON).toBe(VariationType.JSON)
  })

  it('stays aligned with the generated protobuf reasons', () => {
    expect(UFC_REASON.TARGETING_MATCH).toBe(Reason.TARGETING_MATCH)
    expect(UFC_REASON.SPLIT).toBe(Reason.SPLIT)
    expect(UFC_REASON.STATIC).toBe(Reason.STATIC)
    expect(UFC_REASON.DEFAULT).toBe(Reason.DEFAULT)
  })

  it('stays aligned with the generated protobuf comparators', () => {
    expect(UFC_NUMERIC_COMPARATOR.LESS_THAN).toBe(NumericComparator.LESS_THAN)
    expect(UFC_NUMERIC_COMPARATOR.LESS_THAN_OR_EQUAL).toBe(NumericComparator.LESS_THAN_OR_EQUAL)
    expect(UFC_NUMERIC_COMPARATOR.GREATER_THAN).toBe(NumericComparator.GREATER_THAN)
    expect(UFC_NUMERIC_COMPARATOR.GREATER_THAN_OR_EQUAL).toBe(NumericComparator.GREATER_THAN_OR_EQUAL)

    expect(UFC_STRING_COMPARATOR.STARTS_WITH).toBe(StringComparator.STARTS_WITH)
    expect(UFC_STRING_COMPARATOR.ENDS_WITH).toBe(StringComparator.ENDS_WITH)
    expect(UFC_STRING_COMPARATOR.CONTAINS).toBe(StringComparator.CONTAINS)

    expect(UFC_SHA256_STRING_COMPARATOR.STARTS_WITH).toBe(Sha256StringComparator.STARTS_WITH)
    expect(UFC_SHA256_STRING_COMPARATOR.ENDS_WITH).toBe(Sha256StringComparator.ENDS_WITH)

    expect(UFC_VERSION_COMPARATOR.EQUAL).toBe(VersionComparator.EQUAL)
    expect(UFC_VERSION_COMPARATOR.NOT_EQUAL).toBe(VersionComparator.NOT_EQUAL)
    expect(UFC_VERSION_COMPARATOR.LESS_THAN).toBe(VersionComparator.LESS_THAN)
    expect(UFC_VERSION_COMPARATOR.LESS_THAN_OR_EQUAL).toBe(VersionComparator.LESS_THAN_OR_EQUAL)
    expect(UFC_VERSION_COMPARATOR.GREATER_THAN).toBe(VersionComparator.GREATER_THAN)
    expect(UFC_VERSION_COMPARATOR.GREATER_THAN_OR_EQUAL).toBe(VersionComparator.GREATER_THAN_OR_EQUAL)
  })
})
