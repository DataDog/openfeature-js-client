export interface ExposureEvent {
  /** Unix timestamp in milliseconds */
  timestamp: number
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
  }
}
