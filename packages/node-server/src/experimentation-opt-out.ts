export enum ExperimentationOptOutMode {
  Disabled = 'disabled',
  Immediate = 'immediate',
}

export function resolveExperimentationOptOutMode(mode?: ExperimentationOptOutMode): ExperimentationOptOutMode {
  if (mode === undefined) return ExperimentationOptOutMode.Disabled
  if (mode === ExperimentationOptOutMode.Disabled || mode === ExperimentationOptOutMode.Immediate) return mode
  throw new Error('experimentationOptOutMode must be disabled or immediate')
}
