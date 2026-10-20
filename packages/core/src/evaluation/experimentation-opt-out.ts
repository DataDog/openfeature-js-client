/** Validates the customer-owned opt-out timestamp without interpreting its age. */
export function hasExperimentationOptOut(context: Record<string, unknown>): boolean | undefined {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is unavailable in supported client runtimes.
  if (!Object.prototype.hasOwnProperty.call(context, 'dd_experimentation_opt_out_at')) return false
  const value = context.dd_experimentation_opt_out_at
  if (typeof value !== 'string') return undefined
  // Use the same timestamp parser as allocation startAt and endAt.
  return Number.isNaN(new Date(value).getTime()) ? undefined : true
}
