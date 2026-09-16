import type { EvaluationDetails, FlagValue, ResolutionDetails } from '@openfeature/web-sdk'

const OFFLINE_CONFIGURATION_ID_METADATA_KEY = '__dd_offline_configuration_id'

export function withOfflineConfigurationId<T extends FlagValue>(
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
      [OFFLINE_CONFIGURATION_ID_METADATA_KEY]: configurationId,
    },
  }
}

export function getOfflineConfigurationId(details: EvaluationDetails<FlagValue>): string | undefined {
  const configurationId = details.flagMetadata?.[OFFLINE_CONFIGURATION_ID_METADATA_KEY]
  return typeof configurationId === 'string' ? configurationId : undefined
}
