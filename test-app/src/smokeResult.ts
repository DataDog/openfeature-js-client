export type SmokeResult = {
  provider: {
    value: boolean
    reason: string
    variant: string
    attempts: number
    sdkVersion: string
  }
  timeout: {
    errorName: string
  }
  retry: {
    attempts: number
    bodies: string[]
  }
  cancellation: {
    errorName: string
    attempts: number
  }
}
