import type { Hook } from '@openfeature/web-sdk'
import type { FlaggingTrackingInitConfiguration } from '../domain/configuration'

type TrackingToggleOptions =
  | 'enableExposureLogging'
  | 'enableFlagEvaluationTracking'
  | 'enableRumFeatureFlagTracking'
  | 'rum'

export type DatadogTrackingHooksOptions = Omit<FlaggingTrackingInitConfiguration, TrackingToggleOptions>

export interface DatadogTrackingHooks {
  hooks: Hook[]
  initialize(): Promise<void>
}

export interface DatadogTrackingHook {
  hooks: Hook[]
  initialize?(): Promise<void> | void
}

export function createDatadogTrackingHooks(...trackingHooks: DatadogTrackingHook[]): DatadogTrackingHooks {
  return {
    hooks: trackingHooks.reduce<Hook[]>((hooks, trackingHook) => {
      hooks.push(...trackingHook.hooks)
      return hooks
    }, []),
    initialize: async () => {
      await Promise.all(
        trackingHooks.map((trackingHook) => runTrackingLifecycleOperation(() => trackingHook.initialize?.()))
      )
    },
  }
}

export function runTrackingLifecycleOperation(operation: () => Promise<void> | void | undefined): Promise<void> {
  try {
    return Promise.resolve(operation()).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}
