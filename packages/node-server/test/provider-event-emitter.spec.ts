import type { EventHandler, Logger } from '@openfeature/core'
import { ServerProviderEvents } from '@openfeature/core'
import { NodeProviderEventEmitter } from '../src/provider-event-emitter'

describe('NodeProviderEventEmitter', () => {
  let emitter: NodeProviderEventEmitter
  let logger: jest.Mocked<Logger>

  beforeEach(() => {
    emitter = new NodeProviderEventEmitter()
    logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    }
  })

  afterEach(() => {
    emitter.removeAllHandlers()
  })

  describe('emit / addHandler', () => {
    it('invokes a registered handler when the event is emitted', () => {
      const handler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, handler)

      emitter.emit(ServerProviderEvents.Ready)

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('passes the emitted context to the handler', () => {
      const handler = jest.fn()
      emitter.addHandler(ServerProviderEvents.ConfigurationChanged, handler)

      const context = { flagsChanged: ['a', 'b'] }
      emitter.emit(ServerProviderEvents.ConfigurationChanged, context)

      expect(handler).toHaveBeenCalledWith(context)
    })

    it('calls multiple handlers for the same event in registration order', () => {
      const order: string[] = []
      const first = jest.fn(() => order.push('first'))
      const second = jest.fn(() => order.push('second'))

      emitter.addHandler(ServerProviderEvents.Ready, first)
      emitter.addHandler(ServerProviderEvents.Ready, second)
      emitter.emit(ServerProviderEvents.Ready)

      expect(order).toEqual(['first', 'second'])
    })

    it('does not invoke handlers registered for a different event', () => {
      const handler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, handler)

      emitter.emit(ServerProviderEvents.Stale)

      expect(handler).not.toHaveBeenCalled()
    })

    it('invokes the handler once per emit for each time it was added', () => {
      const handler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, handler)
      emitter.addHandler(ServerProviderEvents.Ready, handler)

      emitter.emit(ServerProviderEvents.Ready)
      expect(handler).toHaveBeenCalledTimes(2)

      emitter.emit(ServerProviderEvents.Ready)
      expect(handler).toHaveBeenCalledTimes(4)
    })
  })

  describe('handler error isolation', () => {
    it('does not let a throwing sync handler interrupt emit or other handlers', () => {
      const second = jest.fn()
      emitter.addHandler(ServerProviderEvents.Error, () => {
        throw new Error('boom')
      })
      emitter.addHandler(ServerProviderEvents.Error, second)

      expect(() => emitter.emit(ServerProviderEvents.Error)).not.toThrow()

      expect(second).toHaveBeenCalledTimes(1)
    })

    it('logs handler errors through the configured logger', () => {
      const error = new Error('boom')
      emitter.setLogger(logger)
      emitter.addHandler(ServerProviderEvents.Error, () => {
        throw error
      })

      emitter.emit(ServerProviderEvents.Error)

      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledWith('Error running event handler:', error)
    })

    it('does not throw when no logger is set and a handler errors', () => {
      emitter.addHandler(ServerProviderEvents.Error, () => {
        throw new Error('boom')
      })

      expect(() => emitter.emit(ServerProviderEvents.Error)).not.toThrow()
    })

    it('logs errors from async handlers that reject', async () => {
      const error = new Error('async boom')
      emitter.setLogger(logger)
      emitter.addHandler(ServerProviderEvents.Error, () => Promise.reject(error))

      emitter.emit(ServerProviderEvents.Error)
      // The async wrapper awaits the rejected promise inside its try/catch; flush
      // the microtask queue so the catch branch (and logger call) can run.
      await Promise.resolve()
      await Promise.resolve()

      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledWith('Error running event handler:', error)
    })

    it('swallows errors thrown by the logger itself so delivery is not interrupted', () => {
      const second = jest.fn()
      logger.error.mockImplementation(() => {
        throw new Error('logger is broken')
      })
      emitter.setLogger(logger)
      emitter.addHandler(ServerProviderEvents.Error, () => {
        throw new Error('handler boom')
      })
      emitter.addHandler(ServerProviderEvents.Error, second)

      expect(() => emitter.emit(ServerProviderEvents.Error)).not.toThrow()
      expect(second).toHaveBeenCalledTimes(1)
    })
  })

  describe('removeHandler', () => {
    it('stops a registered handler from being invoked', () => {
      const handler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, handler)
      emitter.removeHandler(ServerProviderEvents.Ready, handler)

      emitter.emit(ServerProviderEvents.Ready)

      expect(handler).not.toHaveBeenCalled()
    })

    it('only removes one instance when the same handler was added multiple times (LIFO)', () => {
      const handler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, handler)
      emitter.addHandler(ServerProviderEvents.Ready, handler)
      emitter.removeHandler(ServerProviderEvents.Ready, handler)

      emitter.emit(ServerProviderEvents.Ready)

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('does not throw when removing a handler that was never registered', () => {
      expect(() =>
        emitter.removeHandler(ServerProviderEvents.Ready, jest.fn()),
      ).not.toThrow()
    })

    it('does not affect handlers registered for other events', () => {
      const readyHandler = jest.fn()
      const staleHandler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, readyHandler)
      emitter.addHandler(ServerProviderEvents.Stale, staleHandler)

      emitter.removeHandler(ServerProviderEvents.Ready, readyHandler)
      emitter.emit(ServerProviderEvents.Stale)

      expect(staleHandler).toHaveBeenCalledTimes(1)
    })

    it('reports no handlers via getHandlers once all handlers for an event are removed', () => {
      const handler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, handler)
      emitter.removeHandler(ServerProviderEvents.Ready, handler)

      expect(emitter.getHandlers(ServerProviderEvents.Ready)).toEqual([])
    })
  })

  describe('removeAllHandlers', () => {
    it('removes only the handlers for the given event type', () => {
      const readyHandler = jest.fn()
      const staleHandler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, readyHandler)
      emitter.addHandler(ServerProviderEvents.Stale, staleHandler)

      emitter.removeAllHandlers(ServerProviderEvents.Ready)
      emitter.emit(ServerProviderEvents.Ready)
      emitter.emit(ServerProviderEvents.Stale)

      expect(readyHandler).not.toHaveBeenCalled()
      expect(staleHandler).toHaveBeenCalledTimes(1)
      expect(emitter.getHandlers(ServerProviderEvents.Stale)).toHaveLength(1)
    })

    it('removes handlers for every event when called with no argument', () => {
      const readyHandler = jest.fn()
      const staleHandler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, readyHandler)
      emitter.addHandler(ServerProviderEvents.Stale, staleHandler)

      emitter.removeAllHandlers()
      emitter.emit(ServerProviderEvents.Ready)
      emitter.emit(ServerProviderEvents.Stale)

      expect(readyHandler).not.toHaveBeenCalled()
      expect(staleHandler).not.toHaveBeenCalled()
      expect(emitter.getHandlers(ServerProviderEvents.Ready)).toEqual([])
      expect(emitter.getHandlers(ServerProviderEvents.Stale)).toEqual([])
    })

    it('allows re-registering handlers after removing all for an event', () => {
      const handler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, handler)
      emitter.removeAllHandlers(ServerProviderEvents.Ready)
      emitter.addHandler(ServerProviderEvents.Ready, handler)

      emitter.emit(ServerProviderEvents.Ready)

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('getHandlers', () => {
    it('returns an empty array for an event with no registered handlers', () => {
      expect(emitter.getHandlers(ServerProviderEvents.Ready)).toEqual([])
    })

    it('returns one entry per registered handler instance', () => {
      const first = jest.fn()
      const second = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, first)
      emitter.addHandler(ServerProviderEvents.Ready, second)

      expect(emitter.getHandlers(ServerProviderEvents.Ready)).toHaveLength(2)
    })

    it('returns the wrapped listeners, not the original handler references', () => {
      const handler: EventHandler = jest.fn()
      emitter.addHandler(ServerProviderEvents.Ready, handler)

      const handlers = emitter.getHandlers(ServerProviderEvents.Ready)
      expect(handlers).toHaveLength(1)
      expect(handlers[0]).not.toBe(handler)
    })
  })

  describe('setLogger', () => {
    it('returns the emitter instance for chaining', () => {
      expect(emitter.setLogger(logger)).toBe(emitter)
    })

    it('uses the most recently set logger for handler errors', () => {
      const firstLogger: jest.Mocked<Logger> = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      }
      emitter.setLogger(firstLogger)
      emitter.addHandler(ServerProviderEvents.Error, () => {
        throw new Error('first')
      })
      emitter.emit(ServerProviderEvents.Error)

      expect(firstLogger.error).toHaveBeenCalledTimes(1)

      const secondLogger: jest.Mocked<Logger> = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      }
      emitter.setLogger(secondLogger)
      emitter.addHandler(ServerProviderEvents.Error, () => {
        throw new Error('second')
      })
      emitter.emit(ServerProviderEvents.Error)

      // Both the previously-registered and newly-registered handlers run on the
      // second emit, and both route errors to the now-current (second) logger.
      expect(secondLogger.error).toHaveBeenCalledTimes(2)
      // The first logger is no longer active, so it is not touched again.
      expect(firstLogger.error).toHaveBeenCalledTimes(1)
    })
  })
})
