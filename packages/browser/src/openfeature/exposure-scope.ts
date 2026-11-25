import type { HookContext, ProviderMetadata } from '@openfeature/web-sdk'

// Whether each registered provider's evaluations are exposures (`recordExposures`).
const datadogProviders = new WeakMap<ProviderMetadata, boolean>()
const transparentWrappers = new WeakMap<ProviderMetadata, ProviderMetadata>()
let warnedUnsupported = false

export function registerDatadogProvider(metadata: ProviderMetadata, recordExposures = true): void {
  datadogProviders.set(metadata, recordExposures)
}

/** A wrapper whose evaluations are the inner provider's, such as DatadogDevtools. */
export function registerTransparentProvider(wrapper: ProviderMetadata, inner: ProviderMetadata): void {
  transparentWrappers.set(wrapper, inner)
}

/**
 * True when the evaluation went through a Datadog provider registered directly,
 * possibly inside transparent wrappers. Exposures are not supported under
 * composed providers such as MultiProvider: their child hooks finish before the
 * outer application hooks can reject the result.
 */
export function supportsExposureAdmission(hookContext: Pick<HookContext, 'providerMetadata'> | undefined): boolean {
  if (registeredRecordExposures(hookContext) !== undefined) return true
  if (!warnedUnsupported) {
    warnedUnsupported = true
    console.warn(
      'Datadog exposures require a directly registered Datadog provider; exposures are disabled for composed providers such as MultiProvider'
    )
  }
  return false
}

/**
 * False when the Datadog provider that evaluated was created with
 * `recordExposures: false`: its evaluations are not exposures for any hook.
 */
export function recordsExposures(hookContext: Pick<HookContext, 'providerMetadata'> | undefined): boolean {
  return registeredRecordExposures(hookContext) !== false
}

function registeredRecordExposures(
  hookContext: Pick<HookContext, 'providerMetadata'> | undefined
): boolean | undefined {
  let metadata: ProviderMetadata | undefined = hookContext?.providerMetadata
  const visited = new Set<ProviderMetadata>()
  while (metadata && !visited.has(metadata)) {
    const recordExposures = datadogProviders.get(metadata)
    if (recordExposures !== undefined) return recordExposures
    visited.add(metadata)
    metadata = transparentWrappers.get(metadata)
  }
  return undefined
}
