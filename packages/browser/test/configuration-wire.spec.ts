import { evaluateRulesBasedConfiguration } from '@datadog/flagging-core'
import { configurationFromString, type FlagsConfigurationWire } from '../src'

function rulesWire(): FlagsConfigurationWire {
  return JSON.stringify({
    version: 1,
    rules: {
      response: 'EgRwcm9kGigKDGJyb3dzZXItZmxhZxIYEAQaAigBIhAKCmFsbG9jYXRpb24iAiADKgJvbg==',
    },
  })
}

describe('configurationFromString browser integration', () => {
  it('returns a configuration compatible with the core evaluator', () => {
    const configuration = configurationFromString(rulesWire())
    expect(configuration.rules).toBeDefined()
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }

    expect(
      evaluateRulesBasedConfiguration(configuration.rules?.response, 'boolean', 'browser-flag', false, {}, logger)
    ).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'STATIC',
    })
  })
})
