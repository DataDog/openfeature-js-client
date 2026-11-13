import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { Logger, ProviderMetadata } from '@openfeature/web-sdk'

export interface DebugConfiguration {
  /** Print complete flag diagnostics to the local console. Disabled by default. */
  debugMode?: boolean
}

/** Lazy fields keep debug disabled cheap and isolate diagnostic failures from SDK behavior. */
export interface DebugLogger {
  readonly enabled: boolean
  readonly instanceId?: string
  event(name: string, fields?: () => unknown): void
  child(fields: Record<string, unknown>): DebugLogger
  logger(original: Logger): Logger
}

export const NO_DEBUG: DebugLogger = {
  enabled: false,
  event: () => {},
  child: () => NO_DEBUG,
  logger: (original) => original,
}

const providers = new WeakMap<ProviderMetadata, DebugLogger>()
const signals = new WeakMap<AbortSignal, DebugLogger>()
const requestOptions = new WeakMap<RequestInit, DebugLogger>()
export function bindDebugRequest(init: RequestInit, debug: DebugLogger): void {
  if (debug.enabled) requestOptions.set(init, debug)
}
export function debugForRequest(init?: RequestInit): DebugLogger {
  return (init && requestOptions.get(init)) ?? debugForSignal(init?.signal ?? undefined)
}
let instances = 0
let writing = false
const CHUNK_SIZE = 16000
const PREFIX = '[Datadog Feature Flags] '

export function createDebugLogger(enabled: boolean | undefined, component = 'provider'): DebugLogger {
  if (enabled !== true) return NO_DEBUG
  const instanceId = 'browser-' + Date.now().toString(36) + '-' + ++instances
  let sequence = 0
  const make = (context: Record<string, unknown>): DebugLogger => ({
    enabled: true,
    instanceId,
    event(name, fields) {
      // A console interceptor may itself evaluate a flag. Never recursively log that evaluation.
      if (writing) return
      writing = true
      try {
        const envelope = {
          sdk: 'openfeature-browser',
          platform: 'browser',
          sdkVersion: __BUILD_ENV__SDK_VERSION__,
          providerInstanceId: instanceId,
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          component,
          ...context,
          event: name,
          details: diagnosticFields(name, fields?.()),
        }
        const serialized = JSON.stringify(snapshot(envelope))
        if (serialized.length <= CHUNK_SIZE) {
          console.log(PREFIX + serialized)
        } else {
          const chunks = Math.ceil(serialized.length / CHUNK_SIZE)
          for (let index = 0; index < chunks; index++) {
            console.log(
              PREFIX +
                JSON.stringify({
                  event: 'debug.chunk',
                  providerInstanceId: instanceId,
                  sequence,
                  chunk: index + 1,
                  chunks,
                  data: serialized.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
                })
            )
          }
        }
      } catch {
        // Do not send diagnostics remotely, retry a broken sink, or fail the operation being observed.
        try {
          console.log(
            PREFIX + JSON.stringify({ event: 'debug.serialization_or_sink_failed', providerInstanceId: instanceId })
          )
        } catch {}
      } finally {
        writing = false
      }
    },
    child(fields) {
      return make({ ...context, ...fields })
    },
    logger(original) {
      const wrap =
        (level: keyof Logger) =>
        (message: string, ...args: unknown[]) => {
          this.event('evaluation.trace', () => ({ level, message, args }))
          original[level](message, ...args)
        }
      return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') }
    },
  })
  const logger = make({})
  logger.event('debug.enabled', () => ({
    destination: 'console.log',
    filter: 'Datadog Feature Flags',
    rawValues: true,
    refresh: 'initialization_or_context_change',
    automaticPolling: false,
  }))
  return logger
}

/** Data descriptors avoid invoking getters/toJSON a second time merely to log a value. */
const contextViews = new WeakMap<object, object>()

function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  const context = value && typeof value === 'object' ? contextViews.get(value) : undefined
  if (context) value = context
  if (value === undefined) return { $type: 'undefined' }
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $type: 'number', value: String(value) }
  if (typeof value === 'function' || typeof value === 'symbol') return { $type: typeof value }
  if (typeof value !== 'object' || value === null) return value
  if (ancestors.has(value)) return { $type: 'circular' }
  ancestors.add(value)
  try {
    if (value instanceof Date) {
      const time = Date.prototype.getTime.call(value)
      return { $type: 'date', value: Number.isFinite(time) ? Date.prototype.toISOString.call(value) : 'Invalid Date' }
    }
    if (value instanceof Map)
      return { $type: 'map', entries: snapshot(Array.from(Map.prototype.entries.call(value)), ancestors) }
    if (value instanceof Set)
      return { $type: 'set', values: snapshot(Array.from(Set.prototype.values.call(value)), ancestors) }
    if (typeof DOMException !== 'undefined' && value instanceof DOMException) {
      return {
        $type: 'DOMException',
        name: Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get?.call(value),
        message: Object.getOwnPropertyDescriptor(DOMException.prototype, 'message')?.get?.call(value),
      }
    }
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null)
    if (value instanceof Error)
      Object.defineProperty(output, '$type', {
        enumerable: true,
        configurable: true,
        value: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), 'name')?.value ?? 'Error',
      })
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of Object.keys(descriptors)) {
      if (context && key === 'dd_assignment_token') continue
      if (Array.isArray(value) && key === 'length') continue
      const descriptor = descriptors[key]
      Object.defineProperty(output, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 'value' in descriptor ? snapshot(descriptor.value, ancestors) : { $type: 'accessor', inspected: false },
      })
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}

export function registerDebugLogger(metadata: ProviderMetadata, debug: DebugLogger): void {
  if (debug.enabled) providers.set(metadata, debug)
}
export function getDebugLogger(metadata: ProviderMetadata): DebugLogger {
  return providers.get(metadata) ?? NO_DEBUG
}
export function bindDebugSignal(signal: AbortSignal, debug: DebugLogger): void {
  if (debug.enabled) signals.set(signal, debug)
}
export function debugForSignal(signal?: AbortSignal): DebugLogger {
  return signal ? (signals.get(signal) ?? NO_DEBUG) : NO_DEBUG
}

/** Only transport configuration is sanitized; flag values and targeting attributes stay complete. */
export function debugOptions(options: object): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options))) {
    if (!('value' in descriptor)) {
      result[key] = { accessor: true }
      continue
    }
    const value = descriptor.value
    if (/token|api.?key|authorization|password|secret/i.test(key)) {
      result[key] = { present: value !== undefined && value !== '' }
    } else if (key === 'replica' && value && typeof value === 'object') {
      result[key] = debugOptions(value)
    } else if (key === 'initialFlagsConfiguration') {
      result[key] = diagnosticConfiguration(value)
    } else if (key === 'exposureCache') {
      result[key] = { implementation: value ? 'application_supplied' : 'none' }
    } else if (key === 'rum' && value && typeof value === 'object') {
      result[key] = mapDiagnosticProperties(value, (name, item) =>
        name === 'sdk' ? { implementation: 'application_supplied' } : item
      )
    } else if (key === 'customHeaders') {
      result[key] = value && typeof value === 'object' ? Object.keys(value) : value
    } else if ((key === 'proxy' || key === 'flaggingProxy') && typeof value === 'string') {
      result[key] = debugUrl(value)
    } else {
      result[key] = value
    }
  }
  return result
}

export function debugUrl(input: string, depth = 0): string {
  try {
    const url = new URL(input, 'https://relative.invalid')
    url.username = ''
    url.password = ''
    const keys: string[] = []
    url.searchParams.forEach((_value, key) => {
      keys.push(key)
    })
    for (const key of keys) {
      if (/token|api.?key|authorization|password|secret|cookie/i.test(key)) url.searchParams.set(key, '[credential]')
      else if (key.toLowerCase() === 'ddforward') {
        const forwarded = url.searchParams.get(key) ?? ''
        url.searchParams.set(key, depth < 4 ? debugUrl(forwarded, depth + 1) : '[nested_forwarding]')
      }
    }
    return depth > 0 && input.startsWith('/') ? url.pathname + url.search + url.hash : url.toString()
  } catch {
    return '[unparseable endpoint]'
  }
}

/** Metadata that does not traverse flag maps; full configuration snapshots belong at install boundaries. */
export function configurationSummaryFields(configuration?: FlagsConfiguration): Record<string, unknown> {
  const precomputed = configuration?.precomputed
  const fetchedAt = precomputed?.fetchedAt ?? configuration?.rules?.fetchedAt
  return {
    assignmentContext: precomputed?.context,
    fetchedAt,
    ageMs: fetchedAt === undefined ? undefined : Date.now() - fetchedAt,
    createdAt: precomputed?.response?.data?.attributes?.createdAt,
    expirationPolicy: 'no_sdk_ttl',
    serverDecisionTrace: 'not_available',
  }
}

export function configurationDebugFields(configuration?: FlagsConfiguration): Record<string, unknown> {
  const precomputed = configuration?.precomputed
  return {
    ...configurationSummaryFields(configuration),
    configuration,
    flagKeys: precomputed && Object.keys(precomputed.response.data.attributes.flags),
    flagCount: precomputed && Object.keys(precomputed.response.data.attributes.flags).length,
    flagErrors: precomputed?.flagErrors,
  }
}

// Correlation is local only: no debug fields enter contexts, metadata or intake payloads.
const evaluations = new WeakMap<object, { id: number; pending: boolean }>()
let evaluationSequence = 0
export function evaluationDebug(context: object, debug: DebugLogger, phase?: 'before' | 'resolve'): DebugLogger {
  if (!debug.enabled || !debug.instanceId) return debug
  let entry = evaluations.get(context)
  if (!entry || ((phase === 'before' || phase === 'resolve') && !entry.pending)) {
    entry = { id: ++evaluationSequence, pending: phase === 'before' }
    evaluations.set(context, entry)
  }
  if (phase === 'resolve') entry.pending = false
  return debug.child({ evaluationId: entry.id })
}
const eventCorrelations = new WeakMap<object, Record<string, unknown>>()
export function bindEventCorrelation(event: object, fields: Record<string, unknown>): void {
  eventCorrelations.set(event, fields)
}
export function eventCorrelation(event: object): Record<string, unknown> | undefined {
  return eventCorrelations.get(event)
}

/** Copy only diagnostic structure; accessors stay descriptors for snapshot() to mark without invoking. */
function mapDiagnosticProperties(value: unknown, transform: (key: string, value: unknown) => unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const copy = Object.create(null)
  let changed = false
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if ('value' in descriptor) {
      const item = transform(key, descriptor.value)
      changed ||= item !== descriptor.value
      Object.defineProperty(copy, key, { ...descriptor, value: item })
    } else Object.defineProperty(copy, key, descriptor)
  }
  return changed ? copy : value
}

function diagnosticContext(value: unknown): unknown {
  // A private view lets snapshot omit only the context root's credential, retaining cycle identity.
  if (!value || typeof value !== 'object') return value
  const view = Object.create(null)
  contextViews.set(view, value)
  return view
}

function diagnosticConfiguration(value: unknown): unknown {
  return mapDiagnosticProperties(value, (key, item) =>
    key === 'precomputed'
      ? mapDiagnosticProperties(item, (name, field) => (name === 'context' ? diagnosticContext(field) : field))
      : item
  )
}

const contextFields = new Set([
  'context',
  'oldContext',
  'newContext',
  'rawContext',
  'normalizedContext',
  'requestedContext',
  'effectiveContext',
  'assignmentContext',
  'pendingContext',
  'previousRequestedContext',
  'applicationContext',
  'targetingContext',
  'user',
])
function diagnosticFields(event: string, value: unknown): unknown {
  return mapDiagnosticProperties(value, (key, item) => {
    if (
      key === 'context' &&
      (event === 'evaluation.requested' || event === 'evaluation.returned' || event === 'tracking.skipped')
    ) {
      return mapDiagnosticProperties(item, (name, field) => (name === 'context' ? diagnosticContext(field) : field))
    }
    if (contextFields.has(key)) return diagnosticContext(item)
    if (key === 'configuration' || key === 'initialConfiguration') return diagnosticConfiguration(item)
    return item
  })
}
