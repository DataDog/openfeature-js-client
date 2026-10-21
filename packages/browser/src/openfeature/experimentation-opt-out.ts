export enum ExperimentationOptOutMode {
  Disabled = 'disabled',
  Immediate = 'immediate',
}

export interface ExperimentationOptOutConfiguration {
  /** Honor the customer-owned `dd_experimentation_opt_out_at` timestamp. Defaults to disabled. */
  experimentationOptOutMode?: ExperimentationOptOutMode
}

export function isImmediateExperimentationOptOut(options: ExperimentationOptOutConfiguration): boolean {
  const mode =
    options.experimentationOptOutMode === undefined
      ? ExperimentationOptOutMode.Disabled
      : options.experimentationOptOutMode
  if (mode !== ExperimentationOptOutMode.Disabled && mode !== ExperimentationOptOutMode.Immediate) {
    throw new Error('experimentationOptOutMode must be disabled or immediate')
  }
  return mode === ExperimentationOptOutMode.Immediate
}
