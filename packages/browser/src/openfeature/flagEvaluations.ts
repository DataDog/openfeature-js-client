import { addTelemetryDebug, type Context } from '@datadog/browser-core'
import { FlagEvaluationAggregator, type FlagEvaluationEvent } from '@datadog/flagging-core'
import {
  ErrorCode,
  type EvaluationContext,
  type EvaluationDetails,
  type FlagValue,
  type HookContext,
} from '@openfeature/web-sdk'
import { bindEventCorrelation, evaluationDebug, eventCorrelation, NO_DEBUG } from '../debug'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { validateAndBuildFlaggingTrackingConfiguration } from '../domain/configuration'
import {
  type EvaluationTelemetryPolicy,
  getEvaluationTrackingContext,
  withEvaluationTelemetryPolicy,
} from './evaluation-telemetry-policy'
import { createFlagEvaluationTransport, type FlagEvaluationTransport } from './flagEvaluationTransport'
import { getPrecomputedDependencyEvaluations } from './precomputed-dependencies'
import type { DatadogTrackingHooks, DatadogTrackingHooksOptions, ManagedTrackingHook } from './tracking'
import { composeDatadogTrackingHooks, createTrackingHookController } from './tracking'

let aggregationInstances = 0

export function createFlagEvalEVPHook(
  configuration: FlaggingTrackingConfiguration,
  getEvaluationContext: (context: EvaluationContext) => EvaluationContext = (context) => context,
  policy?: EvaluationTelemetryPolicy,
  sharedTransport?: FlagEvaluationTransport
): ManagedTrackingHook {
  const transport = sharedTransport ?? createFlagEvaluationTransport(configuration)
  const flagEvaluationBatch = transport.batch
  const completedDependencies = new WeakMap<
    HookContext,
    { context: EvaluationContext; evaluations: ReturnType<typeof getPrecomputedDependencyEvaluations> }
  >()
  const aggregationInstanceId = ++aggregationInstances
  const debug = configuration.debug?.child({ channel: 'evaluation', aggregationInstanceId }) ?? NO_DEBUG
  let activeEvaluation = debug
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
          if (debug.enabled) bindEventCorrelation(eventWithMetadata, eventCorrelation(event) ?? {})
          flagEvaluationBatch.add(eventWithMetadata as unknown as Context)
        } catch (error) {
          debug.event('batch.enqueue_failed', () => ({ error, event }))
          addTelemetryDebug('Error adding flag evaluation to batch', {
            'error.message': error instanceof Error ? error.message : String(error),
          })
        }
      })
    },
    debug.enabled
      ? (diagnostic) => {
          if (diagnostic.event)
            bindEventCorrelation(diagnostic.event, { aggregationId: diagnostic.aggregationId, aggregationInstanceId })
          const logger = diagnostic.type === 'add' ? activeEvaluation : debug
          logger.event(
            diagnostic.type === 'add' ? 'evaluation.aggregate_updated' : 'evaluation.aggregate_flushed',
            () => diagnostic
          )
        }
      : undefined
  )

  aggregator.start()

  // Drain aggregation before the transport uploads its page-exit batch.
  // A hidden tab or canceled navigation may return, so keep the periodic timer active.
  const pageExitSubscription = flagEvaluationBatch.flushController.preparePageExitFlushObservable.subscribe(() => {
    aggregator.flush('page_exit')
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
      // Provider hooks run before application after hooks. Retain prerequisite
      // telemetry in case a later hook replaces the successful root result.
      after: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
        try {
          const evaluations = getPrecomputedDependencyEvaluations(details)
          if (evaluations.length === 0) return
          const context = getEvaluationTrackingContext(details, () => getEvaluationContext(hookContext.context))
          completedDependencies.set(hookContext, { context, evaluations })
        } catch {
          // Telemetry capture must not turn a successful evaluation into an error.
        }
      },
      // Failed evaluations skip `after`; `finally` receives the result returned to the application.
      finally: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
        const completed = completedDependencies.get(hookContext)
        completedDependencies.delete(hookContext)
        const evaluation = evaluationDebug(hookContext.context, debug)
        try {
          // OpenFeature can copy a customer hook's error.code without validation.
          // Restrict telemetry to standard OpenFeature error codes.
          const errorCode =
            details.errorCode === undefined || Object.values(ErrorCode).includes(details.errorCode)
              ? details.errorCode
              : ErrorCode.GENERAL
          const context =
            completed?.context ?? getEvaluationTrackingContext(details, () => getEvaluationContext(hookContext.context))
          const dependencies = getPrecomputedDependencyEvaluations(details)
          const retainedDependencies = dependencies.length > 0 ? dependencies : (completed?.evaluations ?? [])
          activeEvaluation = evaluation
          try {
            for (const dependency of retainedDependencies) {
              const dependencyErrorCode =
                dependency.errorCode === undefined || Object.values(ErrorCode).includes(dependency.errorCode)
                  ? dependency.errorCode
                  : ErrorCode.GENERAL
              aggregator.addEvaluation(context, dependency as EvaluationDetails<FlagValue>, dependencyErrorCode)
            }
            aggregator.addEvaluation(context, details, errorCode)
          } finally {
            activeEvaluation = debug
          }
          evaluation.event('evaluation.aggregated', () => ({
            context,
            details,
            errorCode,
            countDelta: retainedDependencies.length + 1,
          }))
        } catch (error) {
          evaluation.event('evaluation.aggregation_failed', () => ({ error, details }))
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
