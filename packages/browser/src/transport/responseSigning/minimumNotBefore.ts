/**
 * Two values for each trust anchor (SHA-256 hex of the root DER), kept only when they increase:
 * - DRAFT wire, pending the edge and the shared fixtures: the highest signed minimum leaf not-before value.
 * - The high-water mark: the highest issued-at of a fully verified response, bounded by the device clock.
 *
 * This is the only data that required mode persists, and it holds no flag data. Storage is best effort:
 * when localStorage is not available, the values are kept in memory for this page only.
 */
// A new key for the leaf-only rule: a value stored under the earlier any-certificate draft is not reused.
const STORAGE_PREFIX = 'dd-ffe-response-signing-minimum-leaf-not-before-v1:'
const HIGH_WATER_MARK_PREFIX = 'dd-ffe-response-signing-high-water-mark-v1:'
const memory = new Map<string, number>()

function readStorage(key: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw && /^(0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw)
  } catch {
    // Storage can be blocked or unavailable; memory still applies.
  }
  return 0
}

function stored(key: string): number {
  return Math.max(memory.get(key) ?? 0, readStorage(key))
}

/** Store a value only when it is higher than the stored value. Returns whether it was stored. */
function raise(key: string, value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 0 || value <= stored(key)) return false
  memory.set(key, value)
  try {
    globalThis.localStorage?.setItem(key, String(value))
  } catch {
    // Keep the in-memory value when storage rejects the write.
  }
  return true
}

export function storedMinimumNotBefore(anchorKey: string): number {
  return stored(STORAGE_PREFIX + anchorKey)
}

export function raiseMinimumNotBefore(anchorKey: string, value: number): boolean {
  return raise(STORAGE_PREFIX + anchorKey, value)
}

export function storedHighWaterMark(anchorKey: string): number {
  return stored(HIGH_WATER_MARK_PREFIX + anchorKey)
}

export function raiseHighWaterMark(anchorKey: string, value: number): boolean {
  return raise(HIGH_WATER_MARK_PREFIX + anchorKey, value)
}

/** @internal Test hook: forget the in-memory values, as a page reload does. */
export function forgetMinimumNotBeforeInMemory(): void {
  memory.clear()
}

/** @internal Test hook: remove every high-water mark, from memory and from storage. */
export function forgetHighWaterMarks(): void {
  for (const key of [...memory.keys()]) if (key.startsWith(HIGH_WATER_MARK_PREFIX)) memory.delete(key)
  try {
    const storage = globalThis.localStorage
    for (let index = (storage?.length ?? 0) - 1; index >= 0; index--) {
      const key = storage?.key(index)
      if (key?.startsWith(HIGH_WATER_MARK_PREFIX)) storage?.removeItem(key)
    }
  } catch {
    // Nothing to remove when storage is not available.
  }
}
