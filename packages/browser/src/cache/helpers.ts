/** Returns whether `window.localStorage` is available */
export function hasWindowLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    // Chrome throws an error if local storage is disabled, and you try to access it
    return false
  }
}

export function localStorageIfAvailable(): Storage | undefined {
  return hasWindowLocalStorage() ? window.localStorage : undefined
}

/** Returns whether IndexedDB is available */
export function hasIndexedDB(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB
  } catch {
    return false
  }
}
