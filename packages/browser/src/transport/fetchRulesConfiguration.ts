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
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildConfigurationHeaders(options, {
      Accept: 'application/protobuf',
      ...(options.previousConfiguration?.rules?.etag && {
        'If-None-Match': options.previousConfiguration.rules.etag,
      }),
    }),
    signal: options.signal,
  })
  if (response.status === 304 && options.previousConfiguration?.rules) {
    return { rules: options.previousConfiguration.rules }
  }
  if (!response.ok) {
    const errorMessage = await getErrorMessage(response)
    throw new Error(`Failed to fetch flag configuration: ${errorMessage}`)
  }

  const configuration = configurationFromRulesBinary(new Uint8Array(await response.arrayBuffer()))
  if (configuration.rules) {
    configuration.rules.fetchedAt = timeStampNow()
    const etag = response.headers?.get('etag')
    if (etag) configuration.rules.etag = etag
  }
  return configuration
}
