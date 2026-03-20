/** Returns whether IndexedDB is available */
export function hasIndexedDB(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB
  } catch {
    return false
  }
}
