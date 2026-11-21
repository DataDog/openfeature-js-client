import { randomBytes } from 'node:crypto'
import { type ClientFingerprint, FLAG_KEY_SHA256_CAPABILITY, type FlagsConfiguration } from '@datadog/flagging-core'
import {
  ConfigurationPrecomputeError,
  type PrecomputeConfigurationOptions as CorePrecomputeConfigurationOptions,
  DEPENDENCY_KEY_ENCRYPTION_SCHEME,
  type FlagKeyObfuscation,
  precomputeConfiguration as precompute,
} from '@datadog/flagging-core/rules-based'
import type { EvaluationContext } from '@openfeature/core'
import { readPrecomputedCapabilities } from './client-fingerprint'

export type PrecomputeConfigurationOptions = Omit<CorePrecomputeConfigurationOptions, 'obfuscation'> & {
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
  let precomputeOptions: CorePrecomputeConfigurationOptions
  try {
    if (!isPlainOptions(options)) throw new Error('Invalid precomputation options')
    const {
      clientFingerprint,
      obfuscation: _obfuscation,
      ...rest
    } = options as CorePrecomputeConfigurationOptions & PrecomputeConfigurationOptions
    capabilities = readPrecomputedCapabilities(clientFingerprint)
    precomputeOptions = rest
  } catch {
    throw new ConfigurationPrecomputeError('invalid_options')
  }
  if (!capabilities.includes(FLAG_KEY_SHA256_CAPABILITY)) {
    return precompute(configuration, context, precomputeOptions)
  }

  const obfuscation: FlagKeyObfuscation = {
    scheme: 'flag-key-sha256-v1',
    salt: randomBytes(16).toString('hex'),
    dependencyKeyEncryption: { scheme: DEPENDENCY_KEY_ENCRYPTION_SCHEME },
  }
  return precompute(configuration, context, { ...precomputeOptions, obfuscation })
}

function isPlainOptions(value: unknown): value is PrecomputeConfigurationOptions {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
