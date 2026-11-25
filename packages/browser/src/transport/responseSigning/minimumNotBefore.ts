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

/**
 * Each value has its own key, `<prefix><anchor>:<value>`, and a key never changes. Another tab can write at the same
 * time from an older view of storage, so a single key could go back to a lower value. With one key for each value, a
 * writer removes only keys with a lower value, and the highest key always stays. A reader takes the highest key.
 */
function highWaterMarkKeys(anchorKey: string): Array<[key: string, value: number]> {
  const prefix = `${HIGH_WATER_MARK_PREFIX}${anchorKey}:`
  const found: Array<[string, number]> = []
  try {
    const storage = globalThis.localStorage
    for (let index = 0; index < (storage?.length ?? 0); index++) {
      const key = storage?.key(index)
      const raw = key?.startsWith(prefix) ? key.slice(prefix.length) : undefined
      if (raw && /^(0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw)))
        found.push([key!, Number(raw)])
    }
  } catch {
    // Storage can be blocked or unavailable; memory still applies.
  }
  return found
}

export function storedHighWaterMark(anchorKey: string): number {
  const values = highWaterMarkKeys(anchorKey).map(([, value]) => value)
  return Math.max(memory.get(HIGH_WATER_MARK_PREFIX + anchorKey) ?? 0, ...values)
}

/** Store a value only when it is higher than the stored value. Returns whether it was stored. */
export function raiseHighWaterMark(anchorKey: string, value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 0 || value <= storedHighWaterMark(anchorKey)) return false
  memory.set(HIGH_WATER_MARK_PREFIX + anchorKey, value)
  try {
    const storage = globalThis.localStorage
    storage?.setItem(`${HIGH_WATER_MARK_PREFIX}${anchorKey}:${value}`, '1')
    for (const [key, stored] of highWaterMarkKeys(anchorKey)) if (stored < value) storage?.removeItem(key)
  } catch {
    // Keep the in-memory value when storage rejects the write.
  }
  return true
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
