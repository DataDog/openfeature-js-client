/**
 * Manages deferred initialization with timeout support.
 * Encapsulates the pattern of waiting for external resolution/rejection
 * with automatic timeout handling and cleanup.
 */
export class InitializationController {
  private resolve?: (value?: void) => void
  private reject?: (reason?: unknown) => void
  private timeoutId?: NodeJS.Timeout
  private readonly promise: Promise<void>

  constructor(timeoutMs: number, onTimeout: () => void) {
    this.promise = Promise.race([
      // Deferred promise - resolved/rejected externally
      new Promise<void>((resolve, reject) => {
        this.resolve = () => {
          this.cleanup()
          resolve()
        }
        this.reject = (reason) => {
          this.cleanup()
          reject(reason)
        }
      }),
      // Timeout promise
      new Promise<void>(() => {
        this.timeoutId = setTimeout(() => {
          onTimeout()
        }, timeoutMs)
      }),
    ])
  }

  /**
   * Wait for initialization to complete (or timeout)
   */
  async wait(): Promise<void> {
    try {
      await this.promise
    } finally {
      this.cleanup()
    }
  }

  /**
   * Complete initialization successfully
   */
  complete(): void {
    if (this.resolve) {
      this.resolve()
    }
  }

  /**
   * Fail initialization with an error
   */
  fail(error: unknown): void {
    if (this.reject) {
      this.reject(error)
    }
  }

  /**
   * Check if initialization is still in progress
   */
  isInitializing(): boolean {
    return this.resolve !== undefined
  }

  private cleanup(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = undefined
    }
    this.resolve = undefined
    this.reject = undefined
  }
}
