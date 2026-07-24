import { matchesShard } from './matchesShard'

describe('matchesShard', () => {
  it('uses protobuf v1 direct salt concatenation and a four-byte big-endian hash prefix', () => {
    const ranges = [{ start: 26, end: 27 }]

    expect(
      matchesShard(
        {
          salt: 'salt',
          ranges,
          totalShards: 100,
          hashMode: 'PROTOBUF_V1',
        },
        'user'
      )
    ).toBe(true)
    expect(matchesShard({ salt: 'salt', ranges, totalShards: 100 }, 'user')).toBe(false)
  })
})
