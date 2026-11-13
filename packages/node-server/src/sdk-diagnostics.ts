import { performance } from 'node:perf_hooks'

const ERROR_INTERVAL_MS = 60_000
const MAX_DURATION_MS = 24 * 60 * 60 * 1000
const MIN_TIMESTAMP_MS = 946_684_800_000
const MAX_TIMESTAMP_MS = 4_102_444_800_000

type Milestone = { elapsed_ms: number }
type Initialization = {
  started_at_ms: number
  duration_ms: number
  milestones: { configuration_received?: Milestone; provider_ready?: Milestone }
}

/** A provider observation. The integration adds SDK and service identity and handles delivery. */
export type SDKDiagnostic = { timestamp: number } & (
  | {
      event_type: 'sdk_initialization'
      initialization: Initialization & { outcome: 'ready'; final: true }
    }
  | {
      event_type: 'sdk_initialization'
      error_code: 'INIT_FAILED'
      initialization: Initialization & { outcome: 'failed'; final: true }
    }
  | {
      event_type: 'sdk_initialization'
      initialization: Initialization & { outcome: 'incomplete'; final: false; reason: 'provider_closed' }
    }
  | { event_type: 'provider_error'; error_code: 'CONFIG_FETCH_FAILED' }
)

/** Observations describe one provider, not the health of every process in a service. */
export class SDKDiagnostics {
  private startedAt?: number
  private startedMonotonic = 0
  private configurationElapsed?: number
  private finished = false
  private closed = false
  private startupFetch = false
  private fetchFailed = false
  private lastErrorAt = -Infinity

  constructor(private readonly onDiagnostic: (diagnostic: SDKDiagnostic) => void) {}

  start(hasConfiguration: boolean): void {
    if (this.closed || this.startedAt !== undefined) return
    this.startedAt = Date.now()
    this.startedMonotonic = performance.now()
    if (hasConfiguration) this.configurationElapsed = 0
  }

  configurationReceived(): void {
    if (this.startedAt !== undefined && !this.finished && this.configurationElapsed === undefined) {
      this.configurationElapsed = this.elapsed()
    }
  }

  finish(outcome: 'ready' | 'failed' | 'incomplete'): void {
    if (this.closed || this.finished || this.startedAt === undefined) return
    this.finished = true
    const timestamp = Date.now()
    const duration = this.elapsed()
    if (this.startedAt < MIN_TIMESTAMP_MS || timestamp < this.startedAt || duration > MAX_DURATION_MS) return
    const initialization: Initialization = {
      started_at_ms: this.startedAt,
      duration_ms: duration,
      milestones: {},
    }
    if (this.configurationElapsed !== undefined) {
      initialization.milestones.configuration_received = { elapsed_ms: this.configurationElapsed }
    }
    if (outcome === 'ready') {
      initialization.milestones.provider_ready = { elapsed_ms: duration }
      this.emit({ timestamp, event_type: 'sdk_initialization', initialization: { ...initialization, outcome, final: true } })
    } else if (outcome === 'failed') {
      this.emit({
        timestamp,
        event_type: 'sdk_initialization',
        error_code: 'INIT_FAILED',
        initialization: { ...initialization, outcome, final: true },
      })
    } else {
      this.emit({
        timestamp,
        event_type: 'sdk_initialization',
        initialization: { ...initialization, outcome, final: false, reason: 'provider_closed' },
      })
    }
  }

  fetchStarted(): void {
    // The configuration source reports one start for a sequential poll, including all its retries.
    this.startupFetch = !this.finished
  }

  fetchResult(success: boolean): void {
    if (this.closed) return
    if (success) {
      this.fetchFailed = false
      return
    }
    if (this.startupFetch || !this.finished || this.fetchFailed) return
    this.fetchFailed = true
    const now = performance.now()
    if (now - this.lastErrorAt < ERROR_INTERVAL_MS) return
    this.lastErrorAt = now
    this.emit({ timestamp: Date.now(), event_type: 'provider_error', error_code: 'CONFIG_FETCH_FAILED' })
  }

  close(): void {
    if (this.closed) return
    this.finish('incomplete')
    this.closed = true
  }

  private elapsed(): number {
    return Math.max(0, performance.now() - this.startedMonotonic)
  }

  private emit(diagnostic: SDKDiagnostic): void {
    if (diagnostic.timestamp < MIN_TIMESTAMP_MS || diagnostic.timestamp > MAX_TIMESTAMP_MS) return
    try {
      this.onDiagnostic(diagnostic)
    } catch {
      // Diagnostics must not affect initialization, polling, or evaluations.
    }
  }
}
