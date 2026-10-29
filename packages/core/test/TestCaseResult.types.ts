import type { FlagValue } from '@openfeature/core'
import type { PrecomputedFlagMetadata } from '../src/configuration'
import type { VariantType } from '../src/evaluation'

export interface TestCase {
  flag: string
  variationType: VariantType
  defaultValue: FlagValue
  targetingKey: string | null
  attributes: Record<string, unknown>
  capabilities?: Record<string, TestCase['result']>
  result: {
    value: FlagValue
    reason: string
    errorCode?: string
    serialId?: number | null
    doLog?: boolean
    variant?: string
    flagMetadata?: PrecomputedFlagMetadata
  }
}
