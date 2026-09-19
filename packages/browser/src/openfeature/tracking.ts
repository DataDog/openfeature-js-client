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
  shutdown(): Promise<void>
}

export interface DatadogTrackingHook {
  hooks: Hook[]
  initialize?(): Promise<void> | void
  shutdown?(): Promise<void> | void
}

export interface ManagedTrackingHook extends Hook {
  shutdown(): void
}

export function createTrackingHookController(
  start: () => ManagedTrackingHook | Promise<ManagedTrackingHook>
): DatadogTrackingHooks {
  let activeHook: ManagedTrackingHook | undefined
  let lifecycle = Promise.resolve()

  return {
    hooks: [{ after: (...args) => activeHook?.after?.(...args) }],
    initialize: () => {
      // Serialize setup and teardown so shutdown also waits for a pending cache read.
      lifecycle = lifecycle.then(() =>
        runTrackingLifecycleOperation(async () => {
          if (!activeHook) activeHook = await start()
        })
      )
      return lifecycle
    },
    shutdown: () => {
      lifecycle = lifecycle.then(() =>
        runTrackingLifecycleOperation(() => {
          const hook = activeHook
          activeHook = undefined
          hook?.shutdown()
        })
      )
      return lifecycle
    },
  }
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
    shutdown: async () => {
      await Promise.all(
        trackingHooks.map((trackingHook) => runTrackingLifecycleOperation(() => trackingHook.shutdown?.()))
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
