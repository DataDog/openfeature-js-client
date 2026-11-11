import type { HookContext, ProviderMetadata } from '@openfeature/web-sdk'

const datadogProviders = new WeakSet<ProviderMetadata>()
const transparentWrappers = new WeakMap<ProviderMetadata, ProviderMetadata>()
let warnedUnsupported = false

export function registerDatadogProvider(metadata: ProviderMetadata): void {
  datadogProviders.add(metadata)
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
  let metadata: ProviderMetadata | undefined = hookContext?.providerMetadata
  const visited = new Set<ProviderMetadata>()
  while (metadata && !visited.has(metadata)) {
    if (datadogProviders.has(metadata)) return true
    visited.add(metadata)
    metadata = transparentWrappers.get(metadata)
  }
  if (!warnedUnsupported) {
    warnedUnsupported = true
    console.warn(
      'Datadog exposures require a directly registered Datadog provider; exposures are disabled for composed providers such as MultiProvider'
    )
  }
  return false
}
