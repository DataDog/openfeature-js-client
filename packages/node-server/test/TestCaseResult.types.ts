import { EvaluationContextValue, FlagValue } from '@openfeature/server-sdk'
import { VariantType } from '../src/configuration/ufc-v1'
import { PrecomputedFlagMetadata } from '@datadog/flagging-core/src/configuration/configuration'

export interface TestCase {
  flag: string
  variationType: VariantType
  defaultValue: FlagValue
  targetingKey: string
  attributes: Record<string, EvaluationContextValue>
  result: {
    value: FlagValue
    variant?: string
    flagMetadata?: PrecomputedFlagMetadata
  }
}
