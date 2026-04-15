/**
 * Demo of the DDFlagEvaluationDetails waterfall trace via the OpenFeature client.
 * Not committed — run with:
 *   npx jest --testPathPatterns=demo --verbose --silent=false
 */
import type { Channel } from 'node:diagnostics_channel'
import type { ExposureEvent } from '@datadog/flagging-core'
import { OpenFeature } from '@openfeature/server-sdk'
import type { UniversalFlagConfigurationV1 } from '../src/configuration/ufc-v1'
import { DatadogNodeServerProvider } from '../src/provider'

const exposureChannel = {
  hasSubscribers: false,
  publish: () => {},
  subscribe: () => {},
} as unknown as Channel<ExposureEvent>

const PAST = new Date(Date.now() - 86400_000).toISOString()
const FUTURE = new Date(Date.now() + 86400_000).toISOString()

const config: UniversalFlagConfigurationV1 = {
  createdAt: '2026-04-15T12:00:00Z',
  format: 'universal-flag-configuration',
  environment: { name: 'staging' },
  flags: {
    'checkout-v2': {
      key: 'checkout-v2',
      enabled: true,
      variationType: 'BOOLEAN',
      variations: {
        on: { key: 'on', value: true },
        off: { key: 'off', value: false },
      },
      allocations: [
        // 1. expired — AFTER_END_TIME
        { key: 'old-rollout', endAt: PAST as unknown as Date, splits: [{ variationKey: 'on', shards: [] }] },
        // 2. future — BEFORE_START_TIME
        { key: 'future-rollout', startAt: FUTURE as unknown as Date, splits: [{ variationKey: 'on', shards: [] }] },
        // 3. rules: CA/AU (index 0), US (index 1)
        {
          key: 'us-beta',
          rules: [
            { conditions: [{ operator: 'ONE_OF' as never, attribute: 'country', value: ['CA', 'AU'] }] },
            { conditions: [{ operator: 'ONE_OF' as never, attribute: 'country', value: ['US'] }] },
          ],
          splits: [{ variationKey: 'on', shards: [] }],
        },
        // 4. default fallback
        { key: 'default-off', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    },
  },
}

async function show(label: string, context: Record<string, unknown>, flagKey = 'checkout-v2') {
  const provider = new DatadogNodeServerProvider({
    exposureChannel,
    includeEvaluationTrace: true,
  })
  provider.setConfiguration(config)
  OpenFeature.setProvider(provider)
  const client = OpenFeature.getClient()

  const details = await client.getBooleanDetails(flagKey, false, context as never)
  const detailsPretty = {
    ...details,
    flagMetadata: {
      ...details.flagMetadata,
      ddEvaluationTrace: details.flagMetadata?.ddEvaluationTrace
        ? JSON.parse(details.flagMetadata.ddEvaluationTrace as string)
        : undefined,
    },
  }

  const trace = detailsPretty.flagMetadata?.ddEvaluationTrace

  console.log(`\n${'═'.repeat(60)}\n${label}\n${'═'.repeat(60)}`)
  console.log('EvaluationDetails:', JSON.stringify({ ...detailsPretty, flagMetadata: { ...detailsPretty.flagMetadata, ddEvaluationTrace: '(see below)' } }, null, 2))
  console.log('\nddEvaluationTrace:', JSON.stringify(trace, null, 2))
}

describe('DDFlagEvaluationDetails demo', () => {
  it('runs all scenarios', async () => {
    await show('US user', { targetingKey: 'user-us', country: 'US' })
    await show('GB user (rules mismatch → default-off)', { targetingKey: 'user-gb', country: 'GB' })
    await show('flag not found', { targetingKey: 'u' }, 'no-such-flag')
  })
})
