import type { Shard, ShardRange } from '../configuration/ufc-v1'
import { MD5Sharder, type Sharder } from './sharders'

export function matchesShard(shard: Shard, subjectKey: string, customSharder?: Sharder): boolean {
  const sharder = customSharder ?? new MD5Sharder()
  const assignedShard = sharder.getShard(hashKey(shard.salt, subjectKey), shard.totalShards)
  return shard.ranges.some((range) => isInShardRange(assignedShard, range))
}

function isInShardRange(shard: number, range: ShardRange): boolean {
  return range.start <= shard && shard < range.end
}

function hashKey(salt: string, subjectKey: string): string {
  return `${salt}-${subjectKey}`
}
