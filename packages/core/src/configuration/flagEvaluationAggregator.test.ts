import type { EvaluationDetails } from '@openfeature/core'
import { FlagEvaluationAggregator } from './flagEvaluationAggregator'

const environmentId = '11111111-1111-4111-8111-111111111111'

function details(id: string | undefined, name: string | undefined): EvaluationDetails<boolean> {
  return {
    flagKey: 'checkout',
    value: true,
    variant: 'on',
    reason: 'STATIC',
    flagMetadata:
      id === undefined || name === undefined
        ? {}
        : {
            __dd_environment_id: id,
            __dd_environment_name: name,
          },
  }
}

describe('FlagEvaluationAggregator environment identity', () => {
  it('snapshots identity into distinct buckets and retains it during lifecycle flush', () => {
    const onFlush = jest.fn()
    const aggregator = new FlagEvaluationAggregator(30_000, onFlush)

    aggregator.addEvaluation({}, details(environmentId, 'production'))
    aggregator.addEvaluation({}, details(environmentId, 'renamed-production'))
    aggregator.addEvaluation({}, details('22222222-2222-4222-8222-222222222222', 'production'))
    aggregator.addEvaluation({}, details('', 'legacy'))
    aggregator.addEvaluation({}, details(undefined, undefined))
    aggregator.stop('page_exit')

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toEqual([
      expect.objectContaining({ environment: { id: environmentId, name: 'production' }, evaluation_count: 1 }),
      expect.objectContaining({
        environment: { id: environmentId, name: 'renamed-production' },
        evaluation_count: 1,
      }),
      expect.objectContaining({
        environment: { id: '22222222-2222-4222-8222-222222222222', name: 'production' },
        evaluation_count: 1,
      }),
      expect.objectContaining({ environment: { name: 'legacy' }, evaluation_count: 1 }),
      expect.not.objectContaining({ environment: expect.anything() }),
    ])
  })
})
