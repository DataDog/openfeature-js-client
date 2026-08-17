import type { EvaluationContext, EvaluationDetails, FlagMetadata, FlagValue } from '@openfeature/core'
import { createExposureEvent } from '../../src/configuration/exposureEvent'

const context: EvaluationContext = { targetingKey: 'user-123', country: 'US' }

function detailsWith(flagMetadata: FlagMetadata): EvaluationDetails<FlagValue> {
  return {
    flagKey: 'checkout-redesign',
    value: 'red',
    variant: 'treatment',
    reason: 'SPLIT',
    flagMetadata,
  }
}

const baseMetadata: FlagMetadata = { doLog: true, allocationKey: 'allocation-123' }

describe('createExposureEvent', () => {
  it('should build the whole event, including serial_id, from the evaluation metadata', () => {
    const event = createExposureEvent(context, detailsWith({ ...baseMetadata, __dd_split_serial_id: 340132 }))

    expect(event).toEqual({
      allocation: { key: 'allocation-123' },
      flag: { key: 'checkout-redesign' },
      variant: { key: 'treatment' },
      serial_id: 340132,
      subject: {
        id: 'user-123',
        attributes: { country: 'US' },
      },
    })
  })

  it('should not include serial_id when the metadata carries none', () => {
    const event = createExposureEvent(context, detailsWith(baseMetadata))

    expect(event).not.toHaveProperty('serial_id')
    expect(event?.allocation.key).toBe('allocation-123')
  })

  it('should include a serial id of zero', () => {
    const event = createExposureEvent(context, detailsWith({ ...baseMetadata, __dd_split_serial_id: 0 }))

    expect(event).toHaveProperty('serial_id')
    expect(event?.serial_id).toBe(0)
  })

  it.each([
    [-1, 'negative'],
    [1.5, 'not an integer'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'infinite'],
  ])('should drop a serial id of %p (%s) but still build the event', (serialId) => {
    const event = createExposureEvent(context, detailsWith({ ...baseMetadata, __dd_split_serial_id: serialId }))

    expect(event).not.toHaveProperty('serial_id')
    expect(event?.flag.key).toBe('checkout-redesign')
    expect(event?.variant.key).toBe('treatment')
  })

  it('should return undefined when doLog is false, whatever the serial id', () => {
    const event = createExposureEvent(
      context,
      detailsWith({ doLog: false, allocationKey: 'allocation-123', __dd_split_serial_id: 340132 })
    )

    expect(event).toBeUndefined()
  })
})
