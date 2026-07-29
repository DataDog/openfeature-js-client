import type { FlagsConfiguration } from './generated/ufc_pb'

const errorsByConfiguration = new WeakMap<FlagsConfiguration, ReadonlyMap<string, string>>()

export function setFlagConfigurationErrors(
  configuration: FlagsConfiguration,
  errors: ReadonlyMap<string, string>
): void {
  if (errors.size > 0) errorsByConfiguration.set(configuration, errors)
}

export function getFlagConfigurationError(configuration: FlagsConfiguration, flagKey: string): string | undefined {
  return errorsByConfiguration.get(configuration)?.get(flagKey)
}
