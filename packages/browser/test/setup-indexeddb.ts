// Polyfill structuredClone for fake-indexeddb (not available in jsdom)
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = <T>(val: T): T => JSON.parse(JSON.stringify(val))
}

// Auto-register fake IndexedDB globals before any test code runs
import 'fake-indexeddb/auto'
