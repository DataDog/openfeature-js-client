export class TargetingKeyMissingError extends Error {
  constructor() {
    super('Targeting key is required for split evaluation')
    this.name = 'TargetingKeyMissingError'
  }
}

export class FlagConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlagConfigurationError'
  }
}

export class InvalidContextError extends Error {
  constructor() {
    super('Evaluation context is missing a required partition attribute')
    this.name = 'InvalidContextError'
  }
}
