import type { CanonicalFlagSelection, FlagsConfiguration } from '@datadog/flagging-core'
import {
  buildStorageKeySuffix,
  type ExperimentationOptOutPolicy,
  experimentationOptOutCacheKey,
  getMD5Hash,
} from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { signingContextKey } from '../transport/responseSigning/controller'
import { hex, sha256, utf8 } from '../transport/responseSigning/verification'
import { openDB, STORE_NAME } from './indexeddb-store'

function buildConfigKey(clientToken: string, context: EvaluationContext): string {
  const tokenSuffix = buildStorageKeySuffix(clientToken)
  // Sort keys so {a:1, b:2} and {b:2, a:1} produce the same hash
  const sortedContext = JSON.stringify(context, Object.keys(context).sort())
  const contextHash = getMD5Hash(sortedContext)
  return `flags-config-${tokenSuffix}-${contextHash}`
}

export class IndexedDBFlagsCache {
  private readonly clientToken: string
  private readonly selectionSuffix: string

  constructor(
    clientToken: string,
    flagSelection?: CanonicalFlagSelection,
    private readonly signingNamespace?: () => Promise<string | undefined>
  ) {
    this.clientToken = clientToken
    this.selectionSuffix = flagSelection ? `-sel-${getMD5Hash(JSON.stringify(flagSelection))}` : ''
  }

  /** Read cached config for the given context. Returns undefined on miss or any error. */
  async get(
    context: EvaluationContext,
    optedOut: ExperimentationOptOutPolicy = false
  ): Promise<FlagsConfiguration | undefined> {
    try {
      const legacyKey = buildConfigKey(this.clientToken, context)
      const configKey = this.signingNamespace
        ? await this.scopedKey(context, optedOut)
        : `${policyPrefix(optedOut)}-${legacyKey}${this.selectionSuffix}`
      if (!configKey) return undefined
      const db = await openDB()
      try {
        const config = await new Promise<FlagsConfiguration | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const store = tx.objectStore(STORE_NAME)
          const request = store.get(configKey)
          request.onsuccess = () => {
            if (request.result !== undefined) {
              resolve(request.result as FlagsConfiguration)
              return
            }
            if (this.signingNamespace || optedOut || this.selectionSuffix) {
              resolve(undefined)
              return
            }
            // Read older plaintext entries on upgrade. Never expose encoded
            // snapshots written by a prerelease SDK through the legacy key.
            const legacy = store.get(legacyKey)
            legacy.onerror = () => reject(legacy.error)
            legacy.onsuccess = () => {
              const config = legacy.result as FlagsConfiguration | undefined
              const attributes = config?.precomputed?.response?.data?.attributes
              resolve(
                attributes &&
                  (attributes.obfuscated === undefined || attributes.obfuscated === false) &&
                  attributes.obfuscation === undefined
                  ? config
                  : undefined
              )
            }
          }
          request.onerror = () => reject(request.error)
        })
        if (!config || typeof config !== 'object') {
          return undefined
        }
        return config.precomputed ? config : undefined
      } finally {
        db.close()
      }
    } catch {
      return undefined
    }
  }

  /** Fire-and-forget persist. Never throws. */
  set(
    config: FlagsConfiguration,
    context: EvaluationContext,
    optedOut: ExperimentationOptOutPolicy = false,
    signal?: AbortSignal
  ): void {
    // One namespace for new writes keeps plaintext rollback and encoded
    // refreshes in the same slot without changing what older SDKs can read.
    const prefix = policyPrefix(optedOut)
    const configKey = `${prefix}-${buildConfigKey(this.clientToken, context)}${this.selectionSuffix}`
    if (this.signingNamespace) {
      void this.scopedKey(context, optedOut)
        .then((key) => {
          if (key && !signal?.aborted) this.persist(config, key, signal)
        })
        .catch(() => {})
      return
    }
    this.persist(config, configKey, signal)
  }

  private async scopedKey(
    context: EvaluationContext,
    optedOut: ExperimentationOptOutPolicy
  ): Promise<string | undefined> {
    const namespace = await this.signingNamespace?.()
    if (!namespace) return undefined
    return `${namespace}-${policyPrefix(optedOut)}-${hex(await sha256(utf8(signingContextKey(context))))}${this.selectionSuffix}`
  }

  private persist(config: FlagsConfiguration, configKey: string, signal?: AbortSignal): void {
    openDB()
      .then((db) => {
        if (signal?.aborted) {
          db.close()
          return
        }
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.put(config, configKey)
        tx.oncomplete = () => db.close()
        tx.onerror = () => db.close()
        tx.onabort = () => db.close()
      })
      .catch(() => {
        // Silently fail — persistence should never break the SDK
      })
  }
}

function policyPrefix(policy: ExperimentationOptOutPolicy): string {
  return policy ? experimentationOptOutCacheKey(policy) : 'v2'
}
