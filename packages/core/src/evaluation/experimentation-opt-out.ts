import type { FlagsConfiguration } from '../configuration/configuration'

export type ExperimentationOptOutModeValue = 'disabled' | 'immediate' | 'future_experiments_only'
// Boolean arguments preserve the existing shared-core immediate API.
export type ExperimentationOptOutOption = boolean | ExperimentationOptOutModeValue
export interface OptOutInstant {
  seconds: number
  fraction: string
}
export type ExperimentationOptOutPolicy =
  false | { mode: 'immediate' | 'future_experiments_only'; cutoff: OptOutInstant }

/** Compare complete instants without losing fractional precision in JavaScript Date. */
export function parseOptOutInstant(value: unknown): OptOutInstant | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
    value
  )
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
  const offset = zone.toUpperCase() === 'Z' ? 0 : (+zoneHour * 3600 + +zoneMinute * 60) * (sign === '-' ? -1 : 1)
  return { seconds: date.getTime() / 1000 - offset, fraction: fraction.slice(0, 9).replace(/0+$/, '') }
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

export function excludesExperiment(
  policy: ExperimentationOptOutPolicy | boolean,
  doLog: boolean,
  activation?: unknown
): boolean {
  if (!policy || !doLog) return false
  if (policy === true || policy.mode === 'immediate') return true
  const instant = parseOptOutInstant(activation)
  return excludesExperimentAt(policy, doLog, instant)
}

export function excludesExperimentAt(
  policy: ExperimentationOptOutPolicy | boolean,
  doLog: boolean,
  activation?: OptOutInstant
): boolean {
  if (!policy || !doLog) return false
  return (
    policy === true ||
    policy.mode === 'immediate' ||
    !activation ||
    compareOptOutInstants(activation, policy.cutoff) >= 0
  )
}

export function experimentationOptOutCacheKey(policy: ExperimentationOptOutPolicy): string {
  return policy ? `${policy.mode}:${policy.cutoff.seconds}:${policy.cutoff.fraction}` : 'disabled'
}

export const INVALID_EXPERIMENTATION_OPT_OUT =
  'Set dd_experimentation_opt_out_at to a valid timestamp string, or omit the attribute'

/** Validates the customer-owned opt-out timestamp without interpreting its age. */
export function hasExperimentationOptOut(context: Record<string, unknown>): boolean | undefined {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is unavailable in supported client runtimes.
  if (!Object.prototype.hasOwnProperty.call(context, 'dd_experimentation_opt_out_at')) return false
  const value = context.dd_experimentation_opt_out_at
  if (typeof value !== 'string') return undefined
  return parseOptOutInstant(value) ? true : undefined
}

/** Checks that a precomputed snapshot used the requested exclusion policy, including disabled mode. */
export function acknowledgesExperimentationOptOut(
  configuration: FlagsConfiguration | undefined,
  policy: ExperimentationOptOutPolicy = { mode: 'immediate', cutoff: { seconds: 0, fraction: '' } }
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
