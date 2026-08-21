export const UFC_VARIATION_TYPE = {
  STRING: 1,
  INTEGER: 2,
  NUMERIC: 3,
  BOOLEAN: 4,
  JSON: 5,
} as const

export const UFC_REASON = {
  TARGETING_MATCH: 1,
  SPLIT: 2,
  STATIC: 3,
  DEFAULT: 4,
} as const

export const UFC_NUMERIC_COMPARATOR = {
  LESS_THAN: 1,
  LESS_THAN_OR_EQUAL: 2,
  GREATER_THAN: 3,
  GREATER_THAN_OR_EQUAL: 4,
} as const

export const UFC_STRING_COMPARATOR = {
  STARTS_WITH: 1,
  ENDS_WITH: 2,
  CONTAINS: 3,
} as const

export const UFC_SHA256_STRING_COMPARATOR = {
  STARTS_WITH: 1,
  ENDS_WITH: 2,
} as const

export const UFC_VERSION_COMPARATOR = {
  EQUAL: 1,
  NOT_EQUAL: 2,
  LESS_THAN: 3,
  LESS_THAN_OR_EQUAL: 4,
  GREATER_THAN: 5,
  GREATER_THAN_OR_EQUAL: 6,
} as const
