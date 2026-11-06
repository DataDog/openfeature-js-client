import type { Logger } from '@openfeature/core'
import { MD5Sharder, type Sharder } from './sharders'
import type { Shard, ShardRange } from './ufc-v1'

export function matchesShard(shard: Shard, subjectKey: string, customSharder?: Sharder, logger?: Logger): boolean {
  const sharder = customSharder ?? new MD5Sharder()
  const assignedShard = sharder.getShard(hashKey(shard.salt, subjectKey), shard.totalShards)
  const matched = shard.ranges.some((range) => isInShardRange(assignedShard, range))
  logger?.debug('bucket evaluated', {
    subjectKey,
    salt: shard.salt,
    totalShards: shard.totalShards,
    assignedShard,
    ranges: shard.ranges,
    matched,
  })
  return matched
}

function isInShardRange(shard: number, range: ShardRange): boolean {
  return range.start <= shard && shard < range.end
}

function hashKey(salt: string, subjectKey: string): string {
  return `${salt}-${subjectKey}`
}
