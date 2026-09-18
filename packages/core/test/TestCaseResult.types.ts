import type { FlagValue } from '@openfeature/core'
import type { PrecomputedFlagMetadata } from '../src/configuration'
import type { VariantType } from '../src/evaluation'

export interface TestCase {
  flag: string
  variationType: VariantType
  defaultValue: FlagValue
  targetingKey: string | null
  attributes: Record<string, unknown>
  result: {
    value: FlagValue
    reason: string
    errorCode?: string
    variant?: string
    flagMetadata?: PrecomputedFlagMetadata
  }
}
