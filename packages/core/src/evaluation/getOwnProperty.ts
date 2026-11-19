export function getOwnProperty<T>(record: Record<string, T>, key: string): T | undefined {
  return hasOwnKey(record, key) ? record[key] : undefined
}

export function hasOwnKey(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}
