import { runInNewContext } from 'node:vm'
import { cloneSigningContext, signingContextKey } from '../../../src/transport/responseSigning/context'

test('copies dates from another realm and gives them the same identity as local dates', () => {
  const foreign = runInNewContext('new Date(1234)') as Date
  expect(foreign instanceof Date).toBe(false)
  const input = { nested: { date: foreign }, dates: [foreign] }
  const copy = cloneSigningContext(input)
  expect(copy).toEqual({ nested: { date: new Date(1234) }, dates: [new Date(1234)] })
  expect(signingContextKey(input)).toBe(signingContextKey(copy))
  foreign.setTime(5678)
  expect(signingContextKey(input)).not.toBe(signingContextKey(copy))
  expect(copy).toEqual({ nested: { date: new Date(1234) }, dates: [new Date(1234)] })
})

test('preserves invalid dates in detached snapshots without confusing them with null', () => {
  const date = new Date(Number.NaN)
  const copy = cloneSigningContext({ date })
  expect(copy.date).toBeInstanceOf(Date)
  expect(copy.date).not.toBe(date)
  expect(Number.isNaN((copy.date as Date).getTime())).toBe(true)
  expect(signingContextKey(copy)).not.toBe(signingContextKey({ date: null }))
})
