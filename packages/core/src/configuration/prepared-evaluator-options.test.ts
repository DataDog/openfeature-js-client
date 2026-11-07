import { prepareEvaluatorOptions } from './prepared-evaluator-options'

describe('prepared evaluator options', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation()
  })

  afterEach(() => jest.restoreAllMocks())

  it('retains valid JSON evaluator options on the configuration snapshot', () => {
    const configuration = { evaluatorParams: { maxDependencyDepth: 0 } }

    expect(prepareEvaluatorOptions(configuration, false)).toEqual({ maxDependencyDepth: 0 })
    expect(configuration.evaluatorParams).toEqual({ maxDependencyDepth: 0 })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('uses the default without materializing optional absent evaluator options', () => {
    const json: { evaluatorParams?: { maxDependencyDepth: number } } = {}
    const protobuf: { evaluatorParams?: { maxDependencyDepth: bigint } } = {}

    expect(prepareEvaluatorOptions(json, false)).toEqual({ maxDependencyDepth: 10 })
    expect(json.evaluatorParams).toBeUndefined()
    expect(prepareEvaluatorOptions(protobuf, true)).toEqual({ maxDependencyDepth: 10 })
    expect(protobuf.evaluatorParams).toBeUndefined()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it.each([256, -1, 1.5, '10', null, []])('replaces invalid JSON evaluatorParams %p with the default', (value) => {
    const evaluatorParams = value === null || Array.isArray(value) ? value : { maxDependencyDepth: value }
    const configuration = { evaluatorParams }

    expect(prepareEvaluatorOptions(configuration, false)).toEqual({ maxDependencyDepth: 10 })
    expect(configuration.evaluatorParams).toEqual({ maxDependencyDepth: 10 })
    expect(consoleError).toHaveBeenCalledWith('invalid evaluatorParams; using default maxDependencyDepth', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('logs an invalid value once because the persisted replacement is canonical', () => {
    const configuration = { evaluatorParams: { maxDependencyDepth: 256 } }

    prepareEvaluatorOptions(configuration, false)
    prepareEvaluatorOptions(configuration, false)

    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith('invalid evaluatorParams; using default maxDependencyDepth', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('preserves other evaluator options while replacing an invalid depth', () => {
    const configuration = { evaluatorParams: { maxDependencyDepth: 256, futureOption: 'retained' } }

    prepareEvaluatorOptions(configuration, false)

    expect(configuration.evaluatorParams).toEqual({ maxDependencyDepth: 10, futureOption: 'retained' })
  })
})
