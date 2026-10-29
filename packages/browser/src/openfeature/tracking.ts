import type { AssignmentCache } from '@datadog/flagging-core'
import type { Hook } from '@openfeature/web-sdk'
import type { FlaggingTrackingInitConfiguration } from '../domain/configuration'

type TrackingToggleOptions =
  'enableExposureLogging' | 'trackExposures' | 'enableFlagEvaluationTracking' | 'enableRumFeatureFlagTracking' | 'rum'

export type DatadogTrackingHooksOptions = Omit<FlaggingTrackingInitConfiguration, TrackingToggleOptions>

export interface DatadogTrackingHooks {
  hooks: Hook[]
  initialize(): Promise<void>
  shutdown(): Promise<void>
  /** The shared exposure cache, when an exposure controller is part of the composition. */
  readonly exposureCache?: AssignmentCache
}

export interface DatadogTrackingHook {
  hooks: Hook[]
  initialize?(): Promise<void> | void
  shutdown?(): Promise<void> | void
  /** The shared exposure cache owned by an exposure controller. */
  readonly exposureCache?: AssignmentCache
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
    hooks: [
      { before: (...args) => activeHook?.before?.(...args), finally: (...args) => activeHook?.finally?.(...args) },
    ],
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

export function composeDatadogTrackingHooks(...trackingHooks: DatadogTrackingHook[]): DatadogTrackingHooks {
  return {
    hooks: trackingHooks.reduce<Hook[]>((hooks, trackingHook) => {
      hooks.push(...trackingHook.hooks)
      return hooks
    }, []),
    // Exactly one exposure cache can exist in a composition (the exposure
    // controller); surface it so providers can share it.
    exposureCache: trackingHooks.find((trackingHook) => trackingHook.exposureCache)?.exposureCache,
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
