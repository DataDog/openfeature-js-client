/** Optional local diagnostics, separate from the application's operational logger. */
export type EvaluationDiagnostics = (message: string, details: unknown) => void

/** Diagnostic observers must not change evaluation results or exceptions. */
export function traceEvaluation(
  observer: EvaluationDiagnostics | undefined,
  message: string,
  details: () => unknown
): void {
  if (!observer) return
  try {
    observer(message, details())
  } catch {
    // Diagnostics are best effort.
  }
}
