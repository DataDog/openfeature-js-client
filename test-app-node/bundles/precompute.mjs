import {
  configurationFromString,
  configurationToString,
  precomputeConfiguration,
} from '@datadog/openfeature-node-server/rules-based'

export function precomputeBrowserConfiguration(wire, context) {
  return configurationToString(precomputeConfiguration(configurationFromString(wire), context))
}
