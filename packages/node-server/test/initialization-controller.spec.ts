import { InitializationController } from '../src/initialization-controller'

describe('InitializationController', () => {
  beforeEach(() => {
    jest.clearAllTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should complete initialization successfully', async () => {
    const controller = new InitializationController(5000, jest.fn())

    expect(controller.isInitializing()).toBe(true)

    // Complete initialization
    controller.complete()

    // Should resolve successfully
    await controller.wait()

    expect(controller.isInitializing()).toBe(false)
  })

  it('should fail initialization with error', async () => {
    const controller = new InitializationController(5000, jest.fn())

    expect(controller.isInitializing()).toBe(true)

    // Fail initialization
    const error = new Error('test error')
    controller.fail(error)

    // Should reject with the error
    await expect(controller.wait()).rejects.toThrow('test error')

    expect(controller.isInitializing()).toBe(false)
  })

  it('should trigger timeout callback when timeout expires', async () => {
    jest.useFakeTimers()
    const onTimeout = jest.fn()
    const controller = new InitializationController(5000, onTimeout)

    expect(controller.isInitializing()).toBe(true)
    expect(onTimeout).not.toHaveBeenCalled()

    // Fast-forward time by 5 seconds
    jest.advanceTimersByTime(5000)

    // Timeout callback should be invoked
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('should clear timeout when completed before timeout', async () => {
    jest.useFakeTimers()
    const onTimeout = jest.fn()
    const controller = new InitializationController(5000, onTimeout)

    // Complete before timeout
    controller.complete()
    await controller.wait()

    // Fast-forward past timeout
    jest.advanceTimersByTime(6000)

    // Timeout should not trigger
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('should clear timeout when failed before timeout', async () => {
    jest.useFakeTimers()
    const onTimeout = jest.fn()
    const controller = new InitializationController(5000, onTimeout)

    // Fail before timeout
    controller.fail(new Error('early failure'))

    try {
      await controller.wait()
    } catch {
      // Expected to throw
    }

    // Fast-forward past timeout
    jest.advanceTimersByTime(6000)

    // Timeout should not trigger
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('should handle complete() being called multiple times', async () => {
    const controller = new InitializationController(5000, jest.fn())

    // Call complete multiple times
    controller.complete()
    controller.complete()
    controller.complete()

    // Should still resolve successfully once
    await controller.wait()

    expect(controller.isInitializing()).toBe(false)
  })

  it('should handle fail() being called multiple times', async () => {
    const controller = new InitializationController(5000, jest.fn())

    // Call fail multiple times
    controller.fail(new Error('error 1'))
    controller.fail(new Error('error 2'))

    // Should reject with first error
    await expect(controller.wait()).rejects.toThrow('error 1')

    expect(controller.isInitializing()).toBe(false)
  })

  it('should handle complete() after fail() (no-op)', async () => {
    const controller = new InitializationController(5000, jest.fn())

    controller.fail(new Error('test error'))
    controller.complete() // Should be no-op

    // Should still reject
    await expect(controller.wait()).rejects.toThrow('test error')
  })

  it('should handle fail() after complete() (no-op)', async () => {
    const controller = new InitializationController(5000, jest.fn())

    controller.complete()
    controller.fail(new Error('test error')) // Should be no-op

    // Should still resolve successfully
    await controller.wait()
  })

  it('should return false for isInitializing after wait completes', async () => {
    const controller = new InitializationController(5000, jest.fn())

    expect(controller.isInitializing()).toBe(true)

    controller.complete()
    await controller.wait()

    expect(controller.isInitializing()).toBe(false)
  })

  it('should return false for isInitializing after wait rejects', async () => {
    const controller = new InitializationController(5000, jest.fn())

    expect(controller.isInitializing()).toBe(true)

    controller.fail(new Error('test'))

    try {
      await controller.wait()
    } catch {
      // Expected
    }

    expect(controller.isInitializing()).toBe(false)
  })

  it('should handle zero timeout', async () => {
    jest.useFakeTimers()
    const onTimeout = jest.fn()
    const controller = new InitializationController(0, onTimeout)

    // Advance timers immediately
    jest.advanceTimersByTime(0)

    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('should handle very long timeout', async () => {
    jest.useFakeTimers()
    const onTimeout = jest.fn()
    const controller = new InitializationController(999999, onTimeout)

    expect(controller.isInitializing()).toBe(true)

    // Complete before timeout
    controller.complete()
    await controller.wait()

    // Advance past the long timeout
    jest.advanceTimersByTime(1000000)

    // Timeout should not trigger
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
