import type { EvaluationContext } from '@openfeature/core'
import type { TimeStamp } from '../time'

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
  serial_id?: number
  // Split features routed to the EXPOSURE destination. Omitted when there are
  // none, and never part of the exposure cache key or value.
  features?: Record<string, string | number | boolean>
  subject: {
    id: string
    attributes: EvaluationContext
  }
  service?: string
  rum?: {
    application?: {
      id?: string
    }
    view?: {
      url?: string
    }
  }
}

export interface ExposureEventWithTimestamp extends ExposureEvent {
  /** Unix timestamp in milliseconds */
  timestamp: TimeStamp
}
