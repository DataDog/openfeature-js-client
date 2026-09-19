import { getMD5Hash } from '@datadog/flagging-core'
import type { FlaggingTrackingConfiguration, FlaggingTrackingInitConfiguration } from '../domain/configuration'
import { assignmentCacheFactory } from './assignment-cache-factory'
import { chromeStorageIfAvailable } from './helpers'

export function createExposureCache(
  options: Partial<FlaggingTrackingInitConfiguration>,
  configuration: FlaggingTrackingConfiguration
) {
  // A proxy callback can route identical requests to different destinations through closure state.
  const forceMemoryOnly = typeof options.proxy === 'function'
  const scope = getMD5Hash(
    JSON.stringify({
      site: configuration.site,
      clientToken: options.clientToken,
      proxy: typeof options.proxy === 'string' ? new URL(options.proxy, window.location.href).href : undefined,
      internalAnalyticsSubdomain: options.internalAnalyticsSubdomain,
      env: configuration.env,
      applicationId: configuration.applicationId,
      service: configuration.service,
      source: configuration.source,
    })
  )
  return assignmentCacheFactory({
    forceMemoryOnly,
    chromeStorage: chromeStorageIfAvailable(),
    storageKeySuffix: `dd-of-browser-${scope}`,
  })
}
