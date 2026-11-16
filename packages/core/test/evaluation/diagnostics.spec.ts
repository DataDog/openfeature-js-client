import type { Logger } from '@openfeature/core'
import {
  evaluateRulesBasedConfiguration,
  evaluateRulesBasedConfigurationWithTrace,
  type Flag,
  type UniversalFlagConfigurationV1,
} from '../../src/evaluation'
import { traceEvaluation } from '../../src/evaluation/diagnostics'
import { OperatorType } from '../../src/evaluation/rules'

const flag: Flag = {
  key: 'leaf',
  enabled: true,
  variationType: 'BOOLEAN',
  variations: { on: { key: 'on', value: true } },
  allocations: [
    {
      key: 'targeted',
      doLog: true,
      rules: [{ conditions: [{ attribute: 'visits', operator: OperatorType.GTE, value: 2 }] }],
      splits: [
        { variationKey: 'on', shards: [{ salt: 'raw-salt', totalShards: 100, ranges: [{ start: 0, end: 100 }] }] },
      ],
    },
  ],
}
const config: UniversalFlagConfigurationV1 = {
  createdAt: '2026-11-16',
  format: 'SERVER',
  environment: { name: 'test' },
  flags: {
    leaf: flag,
    root: {
      ...flag,
      key: 'root',
      allocations: [
        {
          ...flag.allocations[0],
          rules: [{ conditions: [{ flagEvaluation: { key: 'leaf' }, operator: OperatorType.ONE_OF, value: ['on'] }] }],
        },
      ],
    },
  },
}
const context = { targetingKey: 'raw-subject', visits: '3' }
const makeLogger = (): Logger => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
const rawMessages = ['numeric condition coercion', 'condition evaluated', 'rule evaluated', 'bucket evaluated']

it.each([false, true])('keeps new raw JSON traces off the operational logger with observer=%s', (enabled) => {
  const logger = makeLogger()
  const diagnostics = jest.fn()
  const result = evaluateRulesBasedConfiguration(
    config,
    'boolean',
    'leaf',
    false,
    context,
    logger,
    false,
    enabled ? diagnostics : undefined
  )
  expect(result.value).toBe(true)
  for (const message of rawMessages) {
    expect(logger.debug).not.toHaveBeenCalledWith(message, expect.anything())
    if (enabled) expect(diagnostics).toHaveBeenCalledWith(message, expect.anything())
  }
  expect(logger.debug).toHaveBeenCalledWith('evaluating rules', expect.anything())
  if (!enabled) expect(diagnostics).not.toHaveBeenCalled()
})

it('passes diagnostics into prerequisite evaluations and isolates observer exceptions', () => {
  const diagnostics = jest.fn()
  const result = evaluateRulesBasedConfigurationWithTrace(
    config,
    'boolean',
    'root',
    false,
    context,
    makeLogger(),
    false,
    { diagnostics }
  )
  expect(result.details.value).toBe(true)
  expect(diagnostics).toHaveBeenCalledWith(
    'numeric condition coercion',
    expect.objectContaining({ attributeValue: '3' })
  )
  const throwing = () => {
    throw new Error('diagnostic failure')
  }
  expect(
    evaluateRulesBasedConfiguration(config, 'boolean', 'root', false, context, makeLogger(), false, throwing).value
  ).toBe(true)
})

it('does not construct disabled diagnostic payloads', () => {
  const fields = jest.fn(() => {
    throw new Error('must not run')
  })
  traceEvaluation(undefined, 'test', fields)
  expect(fields).not.toHaveBeenCalled()
})
