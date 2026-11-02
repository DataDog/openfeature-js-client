import type { Context, RawError } from '@datadog/browser-core'
import { addTelemetryDebug, createPageMayExitObservable, Observable } from '@datadog/browser-core'
import { FlagEvaluationAggregator, type FlagEvaluationEvent } from '@datadog/flagging-core'
import {
  ErrorCode,
  type EvaluationContext,
  type EvaluationDetails,
  type FlagValue,
  type HookContext,
} from '@openfeature/web-sdk'
import { NO_DEBUG } from '../debug'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { validateAndBuildFlaggingTrackingConfiguration } from '../domain/configuration'
import { createTrackedBatch } from '../transport/debugBatch'
import {
  type EvaluationTelemetryPolicy,
  getEvaluationTrackingContext,
  withEvaluationTelemetryPolicy,
} from './evaluation-telemetry-policy'
import type { DatadogTrackingHooks, DatadogTrackingHooksOptions, ManagedTrackingHook } from './tracking'
import { composeDatadogTrackingHooks, createTrackingHookController } from './tracking'

export function createFlagEvalEVPHook(
  configuration: FlaggingTrackingConfiguration,
  getEvaluationContext: (context: EvaluationContext) => EvaluationContext = (context) => context,
  policy?: EvaluationTelemetryPolicy
): ManagedTrackingHook {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const sessionExpireObservable = new Observable<void>()
  const debug = configuration.debug?.child({ channel: 'evaluation' }) ?? NO_DEBUG
  const flagEvaluationBatch = createTrackedBatch(
    configuration.flagEvaluationEndpointBuilder,
    (error: RawError) => {
      debug.event('upload.error', () => ({ error }))
      addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
    },
    pageMayExitObservable,
    sessionExpireObservable,
    debug
  )
  debug.event('evaluation.aggregation_started', () => ({ intervalMs: configuration.flagEvaluationTrackingInterval }))

  const aggregator = new FlagEvaluationAggregator(
    configuration.flagEvaluationTrackingInterval,
    (events: FlagEvaluationEvent[]) => {
      debug.event('evaluation.aggregation_flushed', () => ({ events, count: events.length }))
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
          debug.event('batch.enqueue_failed', () => ({ error, event }))
          addTelemetryDebug('Error adding flag evaluation to batch', {
            'error.message': error instanceof Error ? error.message : String(error),
          })
        }
      })
    }
  )

  aggregator.start()

  const pageExitSubscription = pageMayExitObservable.subscribe(() => {
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
          // OpenFeature can copy a customer hook's error.code without validation.
          // Restrict telemetry to standard OpenFeature error codes.
          const errorCode =
            details.errorCode === undefined || Object.values(ErrorCode).includes(details.errorCode)
              ? details.errorCode
              : ErrorCode.GENERAL
          const context = getEvaluationTrackingContext(details, () => getEvaluationContext(hookContext.context))
          aggregator.addEvaluation(context, details, errorCode)
          debug.event('evaluation.aggregated', () => ({ context, details, errorCode, countDelta: 1 }))
        } catch (error) {
          debug.event('evaluation.aggregation_failed', () => ({ error, details }))
          addTelemetryDebug('Error adding evaluation to aggregator', {
            'error.message': error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
    policy,
    debug
  )
}

export function createDatadogEvaluationLoggingHook(options: DatadogTrackingHooksOptions): DatadogTrackingHooks {
  const configuration = validateAndBuildFlaggingTrackingConfiguration(options)
  return configuration
    ? createTrackingHookController(() => createFlagEvalEVPHook(configuration), configuration.debug)
    : composeDatadogTrackingHooks()
}
