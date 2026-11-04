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
import {
  FlagEvaluationAggregator,
  type FlagEvaluationEvent,
  getPrecomputedDependencyEvaluations,
} from '@datadog/flagging-core'
import {
  ErrorCode,
  type EvaluationContext,
  type EvaluationDetails,
  type FlagValue,
  type HookContext,
} from '@openfeature/web-sdk'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { validateAndBuildFlaggingTrackingConfiguration } from '../domain/configuration'
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
  const completedDependencies = new WeakMap<
    HookContext,
    { context: EvaluationContext; evaluations: ReturnType<typeof getPrecomputedDependencyEvaluations> }
  >()
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const sessionExpireObservable = new Observable<void>()
  const flagEvaluationBatch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest([configuration.flagEvaluationEndpointBuilder], (error: RawError) => {
      addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
    }),
    flushController: createFlushController({
      pageMayExitObservable,
      sessionExpireObservable,
    }),
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
          for (const dependency of dependencies.length > 0 ? dependencies : (completed?.evaluations ?? [])) {
            const dependencyErrorCode =
              dependency.errorCode === undefined || Object.values(ErrorCode).includes(dependency.errorCode)
                ? dependency.errorCode
                : ErrorCode.GENERAL
            aggregator.addEvaluation(context, dependency as EvaluationDetails<FlagValue>, dependencyErrorCode)
          }
          aggregator.addEvaluation(context, details, errorCode)
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
