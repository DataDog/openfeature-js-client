import { type AssignmentCache, LRUInMemoryAssignmentCache } from '@datadog/flagging-core'
import type { Hook } from '@openfeature/server-sdk'
import {
  DependencyTelemetrySidecar,
  type DependencyTelemetrySidecarApi,
  ExposureLoggingHook,
  type ExposureSink,
} from './tracking'

/** Shared provider/hook state for the tracer integration. Creates no uploader and installs no hooks. @internal */
export function createExposureTracking(): {
  providerOptions: {
    exposureCache: AssignmentCache
    dependencyTelemetrySidecar: DependencyTelemetrySidecarApi
  }
  createHook(sink: ExposureSink): Hook
  clear(): void
} {
  const exposureCache = new LRUInMemoryAssignmentCache(50_000)
  const dependencyTelemetrySidecar = new DependencyTelemetrySidecar(false)
  return {
    providerOptions: { exposureCache, dependencyTelemetrySidecar },
    createHook(sink: ExposureSink): Hook {
      return new ExposureLoggingHook(exposureCache, sink, dependencyTelemetrySidecar)
    },
    clear(): void {
      exposureCache.clear()
    },
  }
}
