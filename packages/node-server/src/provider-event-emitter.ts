import { EventEmitter } from 'node:events'
import type {
  AnyProviderEvent,
  EventContext,
  EventHandler,
  Logger,
  ProviderEventEmitter,
  ServerProviderEvents,
} from '@openfeature/core'

/**
 * OpenFeature-compatible event emitter that does not require an OpenFeature SDK at runtime.
 */
export class NodeProviderEventEmitter implements ProviderEventEmitter<ServerProviderEvents> {
  private readonly eventEmitter = new EventEmitter()
  private readonly handlers = new Map<AnyProviderEvent, Map<EventHandler, EventHandler[]>>()
  private logger?: Logger

  emit(eventType: ServerProviderEvents, context?: EventContext): void {
    this.eventEmitter.emit(eventType, context)
  }

  addHandler(eventType: AnyProviderEvent, handler: EventHandler): void {
    const asyncHandler: EventHandler = async (details) => {
      try {
        await handler(details)
      } catch (error) {
        this.logHandlerError(error)
      }
    }

    const handlersForEvent = this.handlers.get(eventType) ?? new Map<EventHandler, EventHandler[]>()
    const registeredHandlers = handlersForEvent.get(handler) ?? []
    registeredHandlers.push(asyncHandler)
    handlersForEvent.set(handler, registeredHandlers)
    this.handlers.set(eventType, handlersForEvent)
    this.eventEmitter.on(eventType, asyncHandler)
  }

  removeHandler(eventType: AnyProviderEvent, handler: EventHandler): void {
    const handlersForEvent = this.handlers.get(eventType)
    const registeredHandlers = handlersForEvent?.get(handler)
    const registeredHandler = registeredHandlers?.pop()

    if (registeredHandler) {
      this.eventEmitter.removeListener(eventType, registeredHandler)
    }
    if (registeredHandlers?.length === 0) {
      handlersForEvent?.delete(handler)
    }
    if (handlersForEvent?.size === 0) {
      this.handlers.delete(eventType)
    }
  }

  removeAllHandlers(eventType?: AnyProviderEvent): void {
    if (eventType) {
      this.eventEmitter.removeAllListeners(eventType)
      this.handlers.delete(eventType)
      return
    }

    this.eventEmitter.removeAllListeners()
    this.handlers.clear()
  }

  getHandlers(eventType: AnyProviderEvent): EventHandler[] {
    return this.eventEmitter.listeners(eventType) as EventHandler[]
  }

  setLogger(logger: Logger): this {
    this.logger = logger
    return this
  }

  private logHandlerError(error: unknown): void {
    try {
      this.logger?.error('Error running event handler:', error)
    } catch {
      // A user-provided logger must not interrupt event delivery.
    }
  }
}
