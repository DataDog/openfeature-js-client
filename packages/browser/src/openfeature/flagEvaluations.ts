import type { Context, RawError } from '@datadog/browser-core'
import {
  addTelemetryDebug,
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  createPageMayExitObservable,
  Observable,
} from '@datadog/browser-core'
import { FlagEvaluationAggregator, type FlagEvaluationEvent } from '@datadog/flagging-core'
import type { EvaluationContext, EvaluationDetails, FlagValue, HookContext } from '@openfeature/web-sdk'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { validateAndBuildFlaggingTrackingConfiguration } from '../domain/configuration'
import { type EvaluationTelemetryPolicy, withEvaluationTelemetryPolicy } from './evaluation-telemetry-policy'
import type { DatadogTrackingHooks, DatadogTrackingHooksOptions, ManagedTrackingHook } from './tracking'
import { composeDatadogTrackingHooks, createTrackingHookController } from './tracking'

export function createFlagEvalEVPHook(
  configuration: FlaggingTrackingConfiguration,
  getEvaluationContext: (context: EvaluationContext) => EvaluationContext = (context) => context,
  policy?: EvaluationTelemetryPolicy
): ManagedTrackingHook {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const sessionExpireObservable = new Observable<void>()
  const flushController = createFlushController({ pageMayExitObservable, sessionExpireObservable })
  const flagEvaluationBatch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest([configuration.flagEvaluationEndpointBuilder], (error: RawError) => {
      addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
    }),
    flushController,
  })

  const aggregator = new FlagEvaluationAggregator(
    configuration.flagEvaluationTrackingInterval,
    (events: FlagEvaluationEvent[]) => {
      events.forEach((event) => {
        try {
          const url = window?.location?.href
          const eventWithMetadata: FlagEvaluationEvent = {
            ...event,
            context: {
              ...event.context,
              dd: {
                ...(configuration.service && { service: configuration.service }),
                rum: {
                  ...(configuration.applicationId && { application: { id: configuration.applicationId } }),
                  ...(url && { view: { url } }),
                },
              },
            },
          }
          flagEvaluationBatch.add(eventWithMetadata as unknown as Context)
        } catch (error) {
          addTelemetryDebug('Error adding flag evaluation to batch', {
            'error.message': error instanceof Error ? error.message : String(error),
          })
        }
      })
    }
  )

  aggregator.start()

  // Drain aggregation while the transport is preparing its final page-exit batch.
  const pageExitSubscription = flushController.preparePageExitFlushObservable.subscribe(() => {
    aggregator.stop()
  })

  return withEvaluationTelemetryPolicy(
    {
      shutdown: () => {
        try {
          aggregator.stop()
          sessionExpireObservable.notify()
        } finally {
          pageExitSubscription.unsubscribe()
          flagEvaluationBatch.stop()
        }
      },
      // Failed evaluations skip `after`; `finally` receives the result returned to the application.
      finally: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
        try {
          // The shared aggregator captures consent and sanitizes errors before buffering.
          aggregator.addEvaluation(getEvaluationContext(hookContext.context), details, details.errorCode)
        } catch (error) {
          addTelemetryDebug('Error adding evaluation to aggregator', {
            'error.message': error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
    policy
  )
}

export function createDatadogEvaluationLoggingHook(options: DatadogTrackingHooksOptions): DatadogTrackingHooks {
  const configuration = validateAndBuildFlaggingTrackingConfiguration(options)
  return configuration
    ? createTrackingHookController(() => createFlagEvalEVPHook(configuration))
    : composeDatadogTrackingHooks()
}
