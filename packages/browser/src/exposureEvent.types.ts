export interface ExposureEvent {
  /** RFC 3339 timestamp */
  timestamp: string
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
