export function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage
}

export function chromeStorageIfAvailable(): chrome.storage.StorageArea | undefined {
  return hasChromeStorage() ? chrome.storage.local : undefined
}

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
