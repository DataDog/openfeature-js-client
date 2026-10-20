/** Validates the customer-owned opt-out timestamp without interpreting its age. */
export function hasExperimentationOptOut(context: Record<string, unknown>): boolean | undefined {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is unavailable in supported client runtimes.
  if (!Object.prototype.hasOwnProperty.call(context, 'dd_experimentation_opt_out_at')) return false
  const value = context.dd_experimentation_opt_out_at
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    m < 1 || m > 12 || d < 1 || d > days[m - 1] ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59
  ) return undefined
  return true
}
