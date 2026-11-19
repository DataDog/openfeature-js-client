import type { FlagMetadata } from '@openfeature/core'
import type { PrecomputedConfigurationResponse, PrecomputedFlagMetadata } from '../configuration'
import type { FlagsConfiguration as ProtobufFlagsConfiguration } from '../configuration/generated/ufc_pb'
import type { UniversalFlagConfigurationV1 } from './ufc-v1'

export type EnvironmentIdentity = {
  id: string
  name: string
}

export function rulesEnvironmentIdentity(
  configuration: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration | undefined
): EnvironmentIdentity | undefined {
  if (!configuration) return undefined
  if ('$typeName' in configuration) {
    return identity(configuration.environmentId, configuration.environmentName)
  }
  return identity(configuration.environment?.id, configuration.environment?.name)
}

export function precomputedEnvironmentIdentity(
  response: PrecomputedConfigurationResponse | undefined
): EnvironmentIdentity | undefined {
  const environment = response?.data.attributes.environment
  return identity(environment?.id, environment?.name)
}

export function environmentIdentityMetadata(identity: EnvironmentIdentity | undefined): PrecomputedFlagMetadata {
  return identity
    ? {
        __dd_environment_id: identity.id,
        __dd_environment_name: identity.name,
      }
    : {}
}

export function withEnvironmentIdentity<T extends { flagMetadata?: FlagMetadata }>(
  details: T,
  identity: EnvironmentIdentity | undefined
): T {
  if (!identity) return details
  if (!details.flagMetadata) details.flagMetadata = {}
  const metadata = details.flagMetadata
  metadata.__dd_environment_id = identity.id
  metadata.__dd_environment_name = identity.name
  return details
}

function identity(id: unknown, name: unknown): EnvironmentIdentity | undefined {
  if (typeof name !== 'string') return undefined
  const normalizedId = typeof id === 'string' ? id : ''
  if (!normalizedId && !name) return undefined
  return { id: normalizedId, name }
}
