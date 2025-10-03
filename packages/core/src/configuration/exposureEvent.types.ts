import type { EvaluationContext } from '@openfeature/core'

export interface ExposureEvent {
  allocation: {
    key: string
  }
  flag: {
    key: string
  }
  variant: {
    key: string
  }
  subject: {
    id: string
    attributes: EvaluationContext
  }
}

export interface ExposureEventWithTimestamp extends ExposureEvent {
  /** Unix timestamp in milliseconds */
  timestamp: number
}
