import type { FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'
import { timeStampNow } from '@datadog/js-core/time'
import {
  buildConfigurationHeaders,
  buildConfigurationUrl,
  getErrorMessage,
  type RulesConfigurationFetchOptions,
} from './fetchConfiguration'

export async function fetchRulesConfiguration(options: RulesConfigurationFetchOptions): Promise<FlagsConfiguration> {
  const url = buildConfigurationUrl(options, 'rules')
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

  const configuration = configurationFromRulesBinary(new Uint8Array(await response.arrayBuffer()))
  if (configuration.rules) {
    configuration.rules.fetchedAt = timeStampNow()
  }
  return configuration
}
