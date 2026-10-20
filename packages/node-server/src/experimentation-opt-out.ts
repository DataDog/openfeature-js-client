export enum ExperimentationOptOutMode {
  Default = 'default',
  Disabled = 'disabled',
  Immediate = 'immediate',
}

export function resolveExperimentationOptOutMode(mode?: ExperimentationOptOutMode): ExperimentationOptOutMode {
  if (mode === ExperimentationOptOutMode.Disabled || mode === ExperimentationOptOutMode.Immediate) return mode
  if (mode !== undefined && mode !== ExperimentationOptOutMode.Default) {
    throw new Error('Unsupported experimentation opt-out mode')
  }
  const value = process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'disabled') return ExperimentationOptOutMode.Disabled
  if (value === 'immediate') return ExperimentationOptOutMode.Immediate
  throw new Error('DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE must be disabled or immediate')
}
