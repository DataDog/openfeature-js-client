import type { EvaluationDetails, FlagValue, ResolutionDetails } from '@openfeature/web-sdk'

const CORE_CONFIGURATION_ID_METADATA_KEY = '__dd_core_configuration_id'

export function withCoreConfigurationId<T extends FlagValue>(
  details: ResolutionDetails<T>,
  configurationId: string | undefined
): ResolutionDetails<T> {
  const allocationKey = details.flagMetadata?.allocationKey
  if (
    configurationId === undefined ||
    details.flagMetadata?.doLog !== true ||
    typeof allocationKey !== 'string' ||
    details.variant == null
  ) {
    return details
  }

  return {
    ...details,
    flagMetadata: {
      ...details.flagMetadata,
      [CORE_CONFIGURATION_ID_METADATA_KEY]: configurationId,
    },
  }
}

export function getCoreConfigurationId(details: EvaluationDetails<FlagValue>): string | undefined {
  const configurationId = details.flagMetadata?.[CORE_CONFIGURATION_ID_METADATA_KEY]
  return typeof configurationId === 'string' ? configurationId : undefined
}
