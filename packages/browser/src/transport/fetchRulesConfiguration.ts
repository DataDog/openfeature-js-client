import { canonicalizeFlagSelection, type FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'
import { timeStampNow } from '@datadog/js-core/time'
import { createDebugLogger } from '../debug'
import { debugFetch } from './debugFetch'
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
  const debug = createDebugLogger(options.debugMode, 'rules_fetch')
  const { url, selected } = buildRulesUrl(options)
  debug.event('configuration.selection', () => ({ requested: options.flagSelection, selected }))
  const fetchedAt = timeStampNow()
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const response = await debugFetch(
    fetchImplementation,
    url.toString(),
    {
      method: 'GET',
      headers: buildConfigurationHeaders(
        options,
        {
          Accept: 'application/protobuf',
        },
        'rules'
      ),
      signal: options.signal,
    },
    debug
  )
  if (!response.ok) {
    const errorMessage = await getErrorMessage(response)
    throw new Error(`Failed to fetch flag configuration: ${errorMessage}`)
  }
  if (selected) reportIgnoredFlagSelection(response)

  let bytes: Uint8Array
  let configuration: FlagsConfiguration
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
    configuration = configurationFromRulesBinary(bytes)
  } catch (error) {
    debug.event('configuration.decode_failed', () => ({
      stage: 'body_read_or_protobuf_decode',
      httpStatus: response.status,
      error,
      action: 'reject_response',
    }))
    throw error
  }
  debug.event('configuration.decoded', () => ({ rawBytes: bytes, configuration }))
  if (configuration.rules) {
    configuration.rules.fetchedAt = fetchedAt
  }
  return configuration
}

function buildRulesUrl(options: RulesConfigurationFetchOptions): { url: URL; selected: boolean } {
  const url = buildConfigurationUrl(options, 'rules')
  const { selection, error } = canonicalizeFlagSelection(options.flagSelection)
  if (error) reportDroppedFlagSelection(error)
  if (!selection) return { url, selected: false }

  const urlWithSelection = appendFlagSelectionToUrl(url, selection)
  if (urlWithSelection) return { url: urlWithSelection, selected: true }
  reportDroppedFlagSelection('too_many_values', `the request URL is at most ${MAX_RULES_URL_BYTES} bytes`)
  return { url, selected: false }
}
