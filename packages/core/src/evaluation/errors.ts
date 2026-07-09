export class TargetingKeyMissingError extends Error {
  constructor() {
    super('Targeting key is required for split evaluation')
    this.name = 'TargetingKeyMissingError'
  }
}
