/**
 * DRAFT wire, pending the edge and the shared fixtures.
 *
 * The highest signed minimum leaf not-before value seen for each trust anchor (SHA-256 hex of the root DER).
 * This is the only data that required mode persists, and it holds no flag data. Storage is best effort:
 * when localStorage is not available, the value is kept in memory for this page only.
 */
// A new key for the leaf-only rule: a value stored under the earlier any-certificate draft is not reused.
const STORAGE_PREFIX = 'dd-ffe-response-signing-minimum-leaf-not-before-v1:'
const memory = new Map<string, number>()

function readStorage(anchorKey: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + anchorKey)
    if (raw && /^(0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw)
  } catch {
    // Storage can be blocked or unavailable; memory still applies.
  }
  return 0
}

export function storedMinimumNotBefore(anchorKey: string): number {
  return Math.max(memory.get(anchorKey) ?? 0, readStorage(anchorKey))
}

/** Store a value only when it is higher than the stored value. Returns whether it was stored. */
export function raiseMinimumNotBefore(anchorKey: string, value: number): boolean {
  if (value <= storedMinimumNotBefore(anchorKey)) return false
  memory.set(anchorKey, value)
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + anchorKey, String(value))
  } catch {
    // Keep the in-memory value when storage rejects the write.
  }
  return true
}

/** @internal Test hook: forget the in-memory values, as a page reload does. */
export function forgetMinimumNotBeforeInMemory(): void {
  memory.clear()
}
