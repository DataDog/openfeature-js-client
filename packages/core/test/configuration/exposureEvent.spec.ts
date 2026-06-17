import { createExposureEvent } from '../../src/configuration/exposureEvent'

describe('createExposureEvent', () => {
  it('includes holdout metadata from flag metadata on exposure events', () => {
    const event = createExposureEvent(
      {
        targetingKey: 'user-123',
        plan: 'pro',
      },
      {
        flagKey: 'checkout-redesign',
        value: false,
        variant: 'control',
        reason: 'TARGETING_MATCH',
        flagMetadata: {
          allocationKey: 'allocation-a-holdout-q2-global-holdout',
          variationType: 'boolean',
          doLog: true,
          __dd_holdout_key: 'q2-global-holdout',
          __dd_holdout_variation: 'status_quo',
        },
      }
    )

    expect(event).toMatchObject({
      allocation: { key: 'allocation-a-holdout-q2-global-holdout' },
      flag: { key: 'checkout-redesign' },
      variant: { key: 'control' },
      subject: {
        id: 'user-123',
        attributes: { plan: 'pro' },
      },
      holdout: {
        key: 'q2-global-holdout',
        variation: 'status_quo',
      },
    })
  })
})
