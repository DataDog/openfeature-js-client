export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function reportSuccess(result: Record<string, unknown>): void {
  const global = globalThis as typeof globalThis & { __OPENFEATURE_SMOKE_RESULT__?: Record<string, unknown> }
  global.__OPENFEATURE_SMOKE_RESULT__ = result

  const app = document.querySelector<HTMLDivElement>('#app')
  if (app) app.textContent = JSON.stringify(result, null, 2)
}
