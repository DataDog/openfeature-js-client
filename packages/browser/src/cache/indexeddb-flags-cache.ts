import type { CanonicalFlagSelection, FlagsConfiguration } from '@datadog/flagging-core'
import {
  buildStorageKeySuffix,
  type ExperimentationOptOutPolicy,
  experimentationOptOutCacheKey,
  getMD5Hash,
} from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { configurationDebugFields, type DebugLogger, NO_DEBUG } from '../debug'
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
  private operationSequence = 0

  constructor(
    clientToken: string,
    flagSelection?: CanonicalFlagSelection,
    private readonly signingNamespace?: () => Promise<string | undefined>,
    private readonly debug: DebugLogger = NO_DEBUG
  ) {
    this.clientToken = clientToken
    this.selectionSuffix = flagSelection ? `-sel-${getMD5Hash(JSON.stringify(flagSelection))}` : ''
  }

  /** Read cached config for the given context. Returns undefined on miss or any error. */
  async get(
    context: EvaluationContext,
    optedOut: ExperimentationOptOutPolicy = false,
    logger = this.debug
  ): Promise<FlagsConfiguration | undefined> {
    const debug = logger.child({ cacheOperationId: ++this.operationSequence })
    const started = performance.now()
    debug.event('cache.read_started', () => ({ cache: 'assignments', backend: 'indexeddb', context, optedOut }))
    try {
      const legacyKey = buildConfigKey(this.clientToken, context)
      const configKey = this.signingNamespace
        ? await this.scopedKey(context, optedOut)
        : `${policyPrefix(optedOut)}-${legacyKey}${this.selectionSuffix}`
      if (!configKey) {
        debug.event('cache.read_completed', () => ({
          cache: 'assignments',
          outcome: 'skipped',
          reason: 'signing_namespace_unavailable',
        }))
        return undefined
      }
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
        debug.event('cache.read_completed', () => ({
          cache: 'assignments',
          backend: 'indexeddb',
          context,
          outcome: !config ? 'miss' : config.precomputed ? 'hit' : 'invalid',
          durationMs: performance.now() - started,
          ...configurationDebugFields(config),
        }))
        if (!config || typeof config !== 'object') {
          return undefined
        }
        return config.precomputed ? config : undefined
      } finally {
        db.close()
      }
    } catch (error) {
      debug.event('cache.read_failed', () => ({
        cache: 'assignments',
        context,
        error,
        action: 'continue_without_persistent_cache',
      }))
      return undefined
    }
  }

  /** Fire-and-forget persist. Never throws. */
  set(
    config: FlagsConfiguration,
    context: EvaluationContext,
    optedOut: ExperimentationOptOutPolicy = false,
    signal?: AbortSignal,
    logger = this.debug
  ): void {
    const debug = logger.child({ cacheOperationId: ++this.operationSequence })
    debug.event('cache.write_started', () => ({
      cache: 'assignments',
      context,
      optedOut,
      ...configurationDebugFields(config),
    }))
    const fail = (error: unknown) =>
      debug.event('cache.write_failed', () => ({ cache: 'assignments', error, action: 'retain_memory' }))
    try {
      if (this.signingNamespace) {
        void this.scopedKey(context, optedOut)
          .then((key) => {
            if (!key) debug.event('cache.write_skipped', () => ({ reason: 'signing_namespace_unavailable' }))
            else this.persist(config, key, signal, debug)
          })
          .catch(fail)
        return
      }
      const key = `${policyPrefix(optedOut)}-${buildConfigKey(this.clientToken, context)}${this.selectionSuffix}`
      this.persist(config, key, signal, debug)
    } catch (error) {
      fail(error)
    }
  }

  private async scopedKey(
    context: EvaluationContext,
    optedOut: ExperimentationOptOutPolicy
  ): Promise<string | undefined> {
    const namespace = await this.signingNamespace?.()
    if (!namespace) return undefined
    return `${namespace}-${policyPrefix(optedOut)}-${hex(await sha256(utf8(signingContextKey(context))))}${this.selectionSuffix}`
  }

  private persist(
    config: FlagsConfiguration,
    configKey: string,
    signal: AbortSignal | undefined,
    debug: DebugLogger
  ): void {
    if (signal?.aborted) {
      debug.event('cache.write_skipped', () => ({ reason: 'request_cancelled' }))
      return
    }
    void openDB()
      .then((db) => {
        if (signal?.aborted) {
          debug.event('cache.write_skipped', () => ({ reason: 'request_cancelled' }))
          db.close()
          return
        }
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          tx.objectStore(STORE_NAME).put(config, configKey)
          tx.oncomplete = () => {
            debug.event('cache.write_completed', () => ({ cache: 'assignments', durable: true }))
            db.close()
          }
          tx.onerror = tx.onabort = () => {
            debug.event('cache.write_failed', () => ({
              cache: 'assignments',
              error: tx.error,
              action: 'retain_memory',
            }))
            db.close()
          }
        } catch (error) {
          db.close()
          throw error
        }
      })
      .catch((error) =>
        debug.event('cache.write_failed', () => ({ cache: 'assignments', error, action: 'retain_memory' }))
      )
  }
}

function policyPrefix(policy: ExperimentationOptOutPolicy): string {
  return policy ? experimentationOptOutCacheKey(policy) : 'v2'
}
