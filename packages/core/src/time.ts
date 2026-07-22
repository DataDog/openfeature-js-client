/** Unix epoch timestamp in milliseconds. */
export type TimeStamp = number & { t: 'Epoch time' }

export function timeStampNow(): TimeStamp {
  return new Date().getTime() as TimeStamp
}
