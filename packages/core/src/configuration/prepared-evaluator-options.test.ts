import { prepareEvaluatorOptions, reportEvaluatorOptionsDiagnostic } from './prepared-evaluator-options'

describe('prepared evaluator options', () => {
  it('resolves and retains JSON evaluator options on the configuration snapshot', () => {
    const configuration = { evaluatorParams: { maxDependencyDepth: 0 } }

    const prepared = prepareEvaluatorOptions(configuration, false)
    configuration.evaluatorParams.maxDependencyDepth = 255

    expect(prepared).toMatchObject({ maxDependencyDepth: 0 })
    expect(prepareEvaluatorOptions(configuration, false)).toBe(prepared)
  })

  it('normalizes protobuf bigint depth while preparing the configuration', () => {
    expect(prepareEvaluatorOptions({ evaluatorParams: { maxDependencyDepth: BigInt(255) } }, true)).toMatchObject({
      maxDependencyDepth: 255,
    })
  })

  it.each([256, -1, 1.5, '10', null, []])('retains a diagnostic for invalid evaluatorParams %p', (value) => {
    const evaluatorParams = value === null || Array.isArray(value) ? value : { maxDependencyDepth: value }

    expect(prepareEvaluatorOptions({ evaluatorParams }, false)).toMatchObject({
      maxDependencyDepth: 10,
      diagnostic: 'invalid_evaluator_params',
    })
  })

  it('lets the ordinary evaluator consumer report a prepared diagnostic once', () => {
    const options = prepareEvaluatorOptions({ evaluatorParams: { maxDependencyDepth: 256 } }, false)
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

    reportEvaluatorOptionsDiagnostic(options, logger, 'first')
    reportEvaluatorOptionsDiagnostic(options, logger, 'second')

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('invalid evaluatorParams; using default maxDependencyDepth', {
      flagKey: 'first',
      defaultMaxDependencyDepth: 10,
    })
  })
})
