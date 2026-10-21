import { canonicalizeFlagSelection, type FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'
import { timeStampNow } from '@datadog/js-core/time'
import {
  buildConfigurationHeaders,
  buildConfigurationUrl,
  getErrorMessage,
  type RulesConfigurationFetchOptions,
} from './fetchConfiguration'
import {
  appendFlagSelectionToUrl,
  MAX_RULES_URL_BYTES,
  reportDroppedFlagSelection,
  reportIgnoredFlagSelection,
} from './flagSelection'

export async function fetchRulesConfiguration(options: RulesConfigurationFetchOptions): Promise<FlagsConfiguration> {
  const url = buildRulesUrl(options)
  const fetchedAt = timeStampNow()
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const response = await fetchImplementation(url.toString(), {
    method: 'GET',
    headers: buildConfigurationHeaders(
      options,
      {
        Accept: 'application/protobuf',
      },
      'rules'
    ),
    signal: options.signal,
  })
  if (!response.ok) {
    const errorMessage = await getErrorMessage(response)
    throw new Error(`Failed to fetch flag configuration: ${errorMessage}`)
  }
  reportIgnoredFlagSelection(response)

  const configuration = configurationFromRulesBinary(new Uint8Array(await response.arrayBuffer()))
  if (configuration.rules) {
    configuration.rules.fetchedAt = fetchedAt
  }
  return configuration
}

function buildRulesUrl(options: RulesConfigurationFetchOptions): URL {
  const url = buildConfigurationUrl(options, 'rules')
  const { selection, error } = canonicalizeFlagSelection(options.flagSelection)
  if (error) reportDroppedFlagSelection(error)
  if (!selection) return url

  const urlWithSelection = appendFlagSelectionToUrl(url, selection)
  if (urlWithSelection) return urlWithSelection
  reportDroppedFlagSelection('too_many_values', `the request URL is at most ${MAX_RULES_URL_BYTES} bytes`)
  return url
}
