import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { ProviderMetadata } from '@openfeature/web-sdk'

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
}

export const NO_DEBUG: DebugLogger = {
  enabled: false,
  event: () => {},
  child: () => NO_DEBUG,
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
        const budget: SnapshotBudget = {
          nodes: 0,
          bytes: 0,
          omittedEntries: 0,
          omittedSubtrees: 0,
          omittedStringCodeUnits: 0,
        }
        const record = snapshot(envelope, budget) as Record<string, unknown>
        if (budget.omittedEntries || budget.omittedSubtrees || budget.omittedStringCodeUnits) {
          record.diagnosticTruncation = {
            limits: SNAPSHOT_LIMITS,
            omittedEntries: budget.omittedEntries,
            omittedSubtrees: budget.omittedSubtrees,
            omittedStringCodeUnits: budget.omittedStringCodeUnits,
            descendantCounts: 'not_traversed',
          }
        }
        const serialized = JSON.stringify(record)
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

/** Private lazy views apply schema filtering inside the bounded, descriptor-safe snapshot walk. */
type DiagnosticProjection = {
  source: object
  keys?: readonly string[]
  transform?: (key: string, value: unknown) => unknown
  context?: boolean
}
const diagnosticViews = new WeakMap<object, DiagnosticProjection>()

function diagnosticView(value: object, projection: Omit<DiagnosticProjection, 'source'>): object {
  const previous = diagnosticViews.get(value)
  const before = previous?.transform
  const after = projection.transform
  const view = Object.create(null)
  diagnosticViews.set(view, {
    source: previous?.source ?? value,
    keys: projection.keys ?? previous?.keys,
    context: projection.context ?? previous?.context,
    transform: before && after ? (key, item) => after(key, before(key, item)) : (after ?? before),
  })
  return view
}

// Leave headroom for truncation markers and envelope metadata; charge strings at their
// worst-case JSON UTF-8 size before JSON.stringify or chunking allocates the output.
const SNAPSHOT_LIMITS = { depth: 64, nodes: 10000, encodedBytes: 1024 * 1024 }
type SnapshotBudget = {
  nodes: number
  bytes: number
  omittedEntries: number
  omittedSubtrees: number
  omittedStringCodeUnits: number
}

function snapshot(value: unknown, budget: SnapshotBudget, ancestors = new Set<object>(), depth = 0): unknown {
  const projection = value && typeof value === 'object' ? diagnosticViews.get(value) : undefined
  if (projection) value = projection.source
  const exhausted = () => budget.nodes >= SNAPSHOT_LIMITS.nodes || budget.bytes >= SNAPSHOT_LIMITS.encodedBytes - 2048
  if (depth >= SNAPSHOT_LIMITS.depth || exhausted()) {
    budget.omittedSubtrees++
    budget.nodes++
    budget.bytes += 64
    return { $type: 'truncated', reason: depth >= SNAPSHOT_LIMITS.depth ? 'depth_limit' : 'record_budget' }
  }
  budget.nodes++
  budget.bytes += 64
  if (typeof value === 'string') {
    const remaining = Math.max(0, Math.floor((SNAPSHOT_LIMITS.encodedBytes - 2048 - budget.bytes) / 6))
    if (value.length > remaining) {
      budget.omittedStringCodeUnits += value.length - remaining
      budget.bytes += remaining * 6
      return { $type: 'truncated_string', value: value.slice(0, remaining), omittedCodeUnits: value.length - remaining }
    }
    budget.bytes += value.length * 6
    return value
  }
  if (value === undefined) return { $type: 'undefined' }
  if (typeof value === 'bigint')
    return snapshot({ $type: 'bigint', value: String(value) }, budget, ancestors, depth + 1)
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
    if (value instanceof Map || value instanceof Set) {
      const isMap = value instanceof Map
      const iterator = isMap ? Map.prototype.entries.call(value) : Set.prototype.values.call(value)
      const size = Object.getOwnPropertyDescriptor(isMap ? Map.prototype : Set.prototype, 'size')!.get!.call(value)
      const entries: unknown[] = []
      for (let index = 0; index < size; index++) {
        if (exhausted()) {
          budget.omittedEntries += size - index
          break
        }
        entries.push(snapshot(iterator.next().value, budget, ancestors, depth + 1))
      }
      return isMap ? { $type: 'map', entries } : { $type: 'set', values: entries }
    }
    if (typeof DOMException !== 'undefined' && value instanceof DOMException) {
      return snapshot(
        {
          $type: 'DOMException',
          name: Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get?.call(value),
          message: Object.getOwnPropertyDescriptor(DOMException.prototype, 'message')?.get?.call(value),
        },
        budget,
        ancestors,
        depth + 1
      )
    }
    if (Array.isArray(value)) {
      const output: unknown[] = []
      for (let index = 0; index < value.length; index++) {
        if (exhausted()) {
          budget.omittedEntries += value.length - index
          break
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        output.push(
          !descriptor
            ? null
            : 'value' in descriptor
              ? snapshot(descriptor.value, budget, ancestors, depth + 1)
              : { $type: 'accessor', inspected: false }
        )
        // Sparse slots and accessors also consume the traversal budget.
        if (!descriptor || !('value' in descriptor)) {
          budget.nodes++
          budget.bytes += 64
        }
      }
      return output
    }
    const output: Record<string, unknown> = Object.create(null)
    if (value instanceof Error) output.$type = 'Error'
    const keys = projection?.keys ?? Object.getOwnPropertyNames(value)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (projection?.context && key === 'dd_assignment_token') continue
      if (exhausted() || budget.bytes + key.length * 6 >= SNAPSHOT_LIMITS.encodedBytes - 2048) {
        budget.omittedEntries += keys.length - index
        break
      }
      budget.bytes += key.length * 6
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      output[key] =
        'value' in descriptor
          ? snapshot(
              projection?.transform ? projection.transform(key, descriptor.value) : descriptor.value,
              budget,
              ancestors,
              depth + 1
            )
          : { $type: 'accessor', inspected: false }
      if (!('value' in descriptor)) {
        budget.nodes++
        budget.bytes += 64
      }
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
      result[key] = debugUrl(value, 'proxy')
    } else {
      result[key] = value
    }
  }
  return result
}

export type DebugEndpointSource = 'sdk' | 'proxy' | 'callback' | 'unknown'
const endpointSources = new WeakMap<object, DebugEndpointSource>()
export function registerDebugEndpoint(endpoint: object, source: DebugEndpointSource): void {
  endpointSources.set(endpoint, source)
}
export function debugEndpointSource(endpoint: object): DebugEndpointSource {
  return endpointSources.get(endpoint) ?? 'unknown'
}

export function debugUrl(input: string, source: DebugEndpointSource = 'sdk'): string {
  if (source === 'callback' || source === 'unknown') return '[application endpoint]'
  try {
    const url = new URL(input, 'https://relative.invalid')
    // A proxy's path, query and fragment can all contain credentials.
    if (source === 'proxy') return url.origin + '/[proxy]'
    url.username = ''
    url.password = ''
    url.hash = ''
    const keys: string[] = []
    url.searchParams.forEach((_value, key) => {
      keys.push(key)
    })
    for (const key of keys) {
      if (/token|api.?key|authorization|password|secret|cookie/i.test(key)) url.searchParams.set(key, '[credential]')
      else if (key.toLowerCase() === 'ddforward') url.searchParams.set(key, '[forwarded route]')
    }
    return url.toString()
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
    invalidNumericSources: precomputed?.invalidNumericSources,
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

/** Defer property projection until snapshot() has checked its depth, node and byte budgets. */
function mapDiagnosticProperties(value: unknown, transform: (key: string, value: unknown) => unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return diagnosticView(value, { transform })
}

function diagnosticContext(value: unknown): unknown {
  // Keep source identity for cycle detection while omitting only this context root's credential.
  if (!value || typeof value !== 'object') return value
  return diagnosticView(value, { context: true })
}

function pickDiagnosticFields(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return diagnosticView(value, { keys })
}

function diagnosticFlag(value: unknown): unknown {
  return pickDiagnosticFields(value, [
    'allocationKey',
    'variationKey',
    'variationType',
    'variationValue',
    'reason',
    'doLog',
    'serialId',
    'features',
  ])
}

export function diagnosticResponse(value: unknown): unknown {
  return mapDiagnosticProperties(pickDiagnosticFields(value, ['data']), (_key, data) =>
    mapDiagnosticProperties(pickDiagnosticFields(data, ['attributes']), (_name, attributes) =>
      mapDiagnosticProperties(
        pickDiagnosticFields(attributes, [
          'createdAt',
          'format',
          'environment',
          'observeFullEvaluationData',
          'evaluation_options',
          'obfuscated',
          'obfuscation',
          'flags',
        ]),
        (name, field) => {
          if (name === 'flags') return mapDiagnosticProperties(field, (_flagKey, flag) => diagnosticFlag(flag))
          if (name === 'environment') return pickDiagnosticFields(field, ['name'])
          if (name === 'obfuscation') return pickDiagnosticFields(field, ['scheme', 'salt'])
          if (name === 'evaluation_options')
            return pickDiagnosticFields(field, [
              'experimentation_opt_out',
              'experimentation_opt_out_mode',
              'dd_experimentation_opt_out_at',
            ])
          return field
        }
      )
    )
  )
}

function diagnosticConfiguration(value: unknown): unknown {
  return mapDiagnosticProperties(value, (key, item) =>
    key === 'precomputed'
      ? mapDiagnosticProperties(item, (name, field) =>
          name === 'context' ? diagnosticContext(field) : name === 'response' ? diagnosticResponse(field) : field
        )
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
    if (event === 'context.rum_enrichment' && key === 'accepted') return diagnosticContext(item)
    if ((key === 'error' && event !== 'configuration.selection') || key === 'cacheError')
      return { classification: 'error_details_omitted' }
    if (event === 'provider.event' && key === 'payload') {
      return mapDiagnosticProperties(item, (name, field) =>
        name === 'error' || name === 'message' ? '[error details omitted]' : field
      )
    }
    if (event === 'evaluation.trace' && key === 'args' && Array.isArray(item)) {
      return item.map((arg) =>
        mapDiagnosticProperties(arg, (name, field) => (name === 'rawFlag' ? diagnosticFlag(field) : field))
      )
    }
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
