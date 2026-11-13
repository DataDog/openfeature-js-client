import { addTelemetryDebug, type Context } from '@datadog/browser-core'
import { FlagEvaluationAggregator, type FlagEvaluationEvent } from '@datadog/flagging-core'
import type { EvaluationContext, EvaluationDetails, FlagValue, HookContext } from '@openfeature/web-sdk'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { validateAndBuildFlaggingTrackingConfiguration } from '../domain/configuration'
import {
  type EvaluationTelemetryPolicy,
  getEvaluationTrackingContext,
  withEvaluationTelemetryPolicy,
} from './evaluation-telemetry-policy'
import { createFlagEvaluationTransport, type FlagEvaluationTransport } from './flagEvaluationTransport'
import type { DatadogTrackingHooks, DatadogTrackingHooksOptions, ManagedTrackingHook } from './tracking'
import { composeDatadogTrackingHooks, createTrackingHookController } from './tracking'

export function createFlagEvalEVPHook(
  configuration: FlaggingTrackingConfiguration,
  getEvaluationContext: (context: EvaluationContext) => EvaluationContext = (context) => context,
  policy?: EvaluationTelemetryPolicy,
  sharedTransport?: FlagEvaluationTransport
): ManagedTrackingHook {
  const transport = sharedTransport ?? createFlagEvaluationTransport(configuration)
  const flagEvaluationBatch = transport.batch

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

  // Drain aggregation before the transport uploads its page-exit batch.
  // A hidden tab or canceled navigation may return, so keep the periodic timer active.
  const pageExitSubscription = flagEvaluationBatch.flushController.preparePageExitFlushObservable.subscribe(() => {
    aggregator.flush()
  })

  return withEvaluationTelemetryPolicy(
    {
      shutdown: () => {
        try {
          aggregator.stop()
        } finally {
          pageExitSubscription.unsubscribe()
          if (!sharedTransport) transport.stop()
        }
      },
      // Failed evaluations skip `after`; `finally` receives the result returned to the application.
      finally: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
        try {
          // The shared aggregator captures consent and sanitizes errors before buffering.
          aggregator.addEvaluation(
            getEvaluationTrackingContext(details, () => getEvaluationContext(hookContext.context)),
            details,
            details.errorCode
          )
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
