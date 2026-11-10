import { randomBytes } from 'node:crypto'
import { type ClientFingerprint, FLAG_KEY_SHA256_CAPABILITY, type FlagsConfiguration } from '@datadog/flagging-core'
import {
  ConfigurationPrecomputeError,
  type PrecomputeConfigurationOptions as CorePrecomputeConfigurationOptions,
  encodePrecomputedFlagKey,
  type FlagKeyObfuscation,
  precomputeConfiguration as precompute,
} from '@datadog/flagging-core/rules-based'
import type { EvaluationContext } from '@openfeature/core'
import { readPrecomputedCapabilities } from './client-fingerprint'

export type PrecomputeConfigurationOptions = CorePrecomputeConfigurationOptions & {
  /** Opaque target SDK fingerprint. Forward unchanged from its getter; omission preserves plaintext keys. */
  clientFingerprint?: ClientFingerprint
}

/** Resolve rules locally for one context, then encode keys for the target client without tracking or fetching. */
export function precomputeConfiguration(
  configuration: FlagsConfiguration,
  context: EvaluationContext,
  options: PrecomputeConfigurationOptions = {}
): FlagsConfiguration {
  let capabilities: readonly string[]
  try {
    capabilities = readPrecomputedCapabilities(options.clientFingerprint)
  } catch {
    throw new ConfigurationPrecomputeError('invalid_options')
  }
  const result = precompute(configuration, context, options)
  if (!capabilities.includes(FLAG_KEY_SHA256_CAPABILITY)) return result

  const encoding: FlagKeyObfuscation = { scheme: 'flag-key-sha256-v1', salt: randomBytes(16).toString('hex') }
  const attributes = result.precomputed!.response.data.attributes
  const flags = Object.fromEntries(
    Object.entries(attributes.flags).map(([key, assignment]) => {
      const encoded = encodePrecomputedFlagKey(key, encoding)
      if ('error' in encoded) throw new ConfigurationPrecomputeError('invalid_configuration')
      return [encoded.key, assignment]
    })
  )
  attributes.flags = flags
  attributes.obfuscated = true
  attributes.obfuscation = encoding
  return result
}
