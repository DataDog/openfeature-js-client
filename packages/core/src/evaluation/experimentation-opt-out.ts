import type { FlagsConfiguration } from '../configuration/configuration'
import type { RandomizationActivation } from '../configuration/prepared-activation'
import { FlagConfigurationError } from './errors'

export type ExperimentationOptOutModeValue = 'disabled' | 'immediate' | 'future_experiments_only'
// Boolean arguments preserve the existing shared-core immediate API.
export type ExperimentationOptOutOption = boolean | ExperimentationOptOutModeValue
export interface OptOutInstant {
  readonly seconds: number
  readonly fraction: string
}
export type ExperimentationOptOutPolicy =
  false | { mode: 'immediate' | 'future_experiments_only'; cutoff: OptOutInstant }

/** Parse the shared canonical timestamp subset, preserving up to nanosecond precision. */
export function parseOptOutInstant(value: unknown): OptOutInstant | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, fraction = '', zone, sign, zoneHour = '0', zoneMinute = '0'] = match
  const date = new Date(0)
  date.setUTCFullYear(+year, +month - 1, +day)
  date.setUTCHours(+hour, +minute, +second, 0)
  if (
    date.getUTCFullYear() !== +year ||
    date.getUTCMonth() !== +month - 1 ||
    date.getUTCDate() !== +day ||
    +hour > 23 ||
    +minute > 59 ||
    +second > 59 ||
    +zoneHour > 23 ||
    +zoneMinute > 59
  )
    return undefined
  const offset = zone === 'Z' ? 0 : (+zoneHour * 3600 + +zoneMinute * 60) * (sign === '-' ? -1 : 1)
  date.setTime(date.getTime() - offset * 1000)
  // The UTC acknowledgement must also fit the four-digit year format.
  if (date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) return undefined
  return { seconds: date.getTime() / 1000, fraction: fraction.replace(/0+$/, '') }
}

export function compareOptOutInstants(left: OptOutInstant, right: OptOutInstant): number {
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1
  const width = Math.max(left.fraction.length, right.fraction.length)
  const a = left.fraction.padEnd(width, '0')
  const b = right.fraction.padEnd(width, '0')
  return a === b ? 0 : a < b ? -1 : 1
}

export function experimentationOptOutPolicy(
  context: Record<string, unknown>,
  mode: ExperimentationOptOutOption = false
): ExperimentationOptOutPolicy | undefined {
  if (mode === false || mode === 'disabled') return false
  // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is unavailable in supported client runtimes.
  if (!Object.prototype.hasOwnProperty.call(context, 'dd_experimentation_opt_out_at')) return false
  const cutoff = parseOptOutInstant(context.dd_experimentation_opt_out_at)
  return cutoff ? { mode: mode === true ? 'immediate' : mode, cutoff } : undefined
}

/** Only an opted-out subject in future mode needs activation metadata. */
export function needsActivation(policy: ExperimentationOptOutPolicy | boolean): boolean {
  return typeof policy === 'object' && policy.mode === 'future_experiments_only'
}

export function excludesExperimentAt(
  policy: ExperimentationOptOutPolicy | boolean,
  doLog: boolean,
  activation: RandomizationActivation
): boolean {
  if (!policy || !doLog) return false
  if (policy === true || policy.mode === 'immediate') return true
  // Invalid metadata must never become an absent activation for a future consumer.
  if (activation.kind === 'invalid') throw new FlagConfigurationError('Invalid randomization activation timestamp')
  return activation.kind === 'missing' || compareOptOutInstants(activation.instant, policy.cutoff) >= 0
}

export function experimentationOptOutCacheKey(policy: ExperimentationOptOutPolicy): string {
  return policy ? `${policy.mode}:${policy.cutoff.seconds}:${policy.cutoff.fraction}` : 'disabled'
}

export const INVALID_EXPERIMENTATION_OPT_OUT =
  'Set dd_experimentation_opt_out_at to YYYY-MM-DDTHH:mm:ss[.fraction] with Z or +/-HH:mm (up to 9 fractional digits), or omit the attribute'

/** Validates the customer-owned opt-out timestamp without interpreting its age. */
export function hasExperimentationOptOut(context: Record<string, unknown>): boolean | undefined {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is unavailable in supported client runtimes.
  if (!Object.prototype.hasOwnProperty.call(context, 'dd_experimentation_opt_out_at')) return false
  return parseOptOutInstant(context.dd_experimentation_opt_out_at) ? true : undefined
}

/** Checks that a precomputed snapshot used the requested exclusion policy, including disabled mode. */
export function acknowledgesExperimentationOptOut(
  configuration: FlagsConfiguration | undefined,
  policy: ExperimentationOptOutPolicy
): boolean {
  const acknowledgement = configuration?.precomputed?.response.data.attributes.evaluation_options
  if (!policy)
    return (
      acknowledgement?.experimentation_opt_out !== true &&
      acknowledgement?.experimentation_opt_out_mode !== 'immediate' &&
      acknowledgement?.experimentation_opt_out_mode !== 'future_experiments_only'
    )
  if (policy.mode === 'immediate')
    return (
      acknowledgement?.experimentation_opt_out === true &&
      (acknowledgement.experimentation_opt_out_mode === undefined ||
        acknowledgement.experimentation_opt_out_mode === 'immediate')
    )
  const cutoff = parseOptOutInstant(acknowledgement?.dd_experimentation_opt_out_at)
  return (
    acknowledgement?.experimentation_opt_out_mode === policy.mode &&
    !!cutoff &&
    compareOptOutInstants(cutoff, policy.cutoff) === 0
  )
}
