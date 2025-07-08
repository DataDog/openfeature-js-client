export interface DDRum {
  // biome-ignore lint/suspicious/noExplicitAny: DD RUM interface
  addFeatureFlagEvaluation: (flagKey: string, value: any) => void
  // biome-ignore lint/suspicious/noExplicitAny: DD RUM interface
  addAction: (actionName: string, params: Record<string, any>) => void
}
