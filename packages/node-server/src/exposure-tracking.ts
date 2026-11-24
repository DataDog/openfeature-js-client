import { type AssignmentCache, LRUInMemoryAssignmentCache } from '@datadog/flagging-core'
import type { Hook } from '@openfeature/server-sdk'
import {
  DependencyTelemetrySidecar,
  type DependencyTelemetrySidecarApi,
  ExposureLoggingHook,
  type ExposureSink,
} from './tracking'

/**
 * Shared provider/hook state for the tracer integration. Creates no uploader and installs no hooks.
 * Pass providerOptions without replacing its cache or sidecar. Register each sink only once,
 * through either createHook() or exposureChannel. Sharing this state also shares deduplication
 * and configuration-generation resets; the integration owns clear() at shutdown.
 * @internal
 */
export function createExposureTracking(options: { collectDependencyEvaluations?: boolean } = {}): {
  providerOptions: {
    exposureCache: AssignmentCache
    dependencyTelemetrySidecar: DependencyTelemetrySidecarApi
  }
  createHook(sink: ExposureSink): Hook
  clear(): void
} {
  const exposureCache = new LRUInMemoryAssignmentCache(50_000)
  const dependencyTelemetrySidecar = new DependencyTelemetrySidecar(options.collectDependencyEvaluations ?? false)
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
