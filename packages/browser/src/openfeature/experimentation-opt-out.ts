export enum ExperimentationOptOutMode {
  Disabled = 'disabled',
  Immediate = 'immediate',
  FutureExperimentsOnly = 'future_experiments_only',
}

export interface ExperimentationOptOutConfiguration {
  /** Honor the customer-owned `dd_experimentation_opt_out_at` timestamp. Defaults to disabled. */
  experimentationOptOutMode?: ExperimentationOptOutMode
}

export function getExperimentationOptOutMode(options: ExperimentationOptOutConfiguration): ExperimentationOptOutMode {
  const mode =
    options.experimentationOptOutMode === undefined
      ? ExperimentationOptOutMode.Disabled
      : options.experimentationOptOutMode
  if (
    mode !== ExperimentationOptOutMode.Disabled &&
    mode !== ExperimentationOptOutMode.Immediate &&
    mode !== ExperimentationOptOutMode.FutureExperimentsOnly
  ) {
    throw new Error('experimentationOptOutMode must be disabled, immediate, or future_experiments_only')
  }
  return mode
}
