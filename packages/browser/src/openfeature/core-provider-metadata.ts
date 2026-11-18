import type { EvaluationDetails, FlagValue, ResolutionDetails } from '@openfeature/web-sdk'
import { inheritPrecomputedDependencyEvaluations } from './precomputed-dependencies'

const CORE_CONFIGURATION_ID_METADATA_KEY = '__dd_core_configuration_id'

export function withCoreConfigurationId<T extends FlagValue>(
  details: ResolutionDetails<T>,
  configurationId: string | undefined
): ResolutionDetails<T> {
  const sourceMetadata = details.flagMetadata
  const allocationKey = sourceMetadata?.allocationKey
  if (
    !sourceMetadata ||
    configurationId === undefined ||
    typeof allocationKey !== 'string' ||
    details.variant == null
  ) {
    return details
  }

  const flagMetadata = {
    ...sourceMetadata,
    [CORE_CONFIGURATION_ID_METADATA_KEY]: configurationId,
  }
  inheritPrecomputedDependencyEvaluations(sourceMetadata, flagMetadata)
  return {
    ...details,
    flagMetadata,
  }
}

export function getCoreConfigurationId(details: EvaluationDetails<FlagValue>): string | undefined {
  const configurationId = details.flagMetadata?.[CORE_CONFIGURATION_ID_METADATA_KEY]
  return typeof configurationId === 'string' ? configurationId : undefined
}
