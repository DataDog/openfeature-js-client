import { createBatch } from '@datadog/browser-core'
import { createEndpointBuilder } from '@datadog/js-core/transport'
import type { FlaggingConfiguration } from '../domain/configuration'

export function startExposuresBatch(configuration: FlaggingConfiguration, reportError: (message: string) => void) {
  return createBatch({
    endpoints: [createEndpointBuilder(configuration, 'exposures')],
    reportError,
  })
}
