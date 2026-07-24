import { MD5Sharder, type Sharder } from './sharders'
import type { Shard, ShardRange } from './ufc-v1'

export function matchesShard(shard: Shard, subjectKey: string, customSharder?: Sharder): boolean {
  const protobufV1 = shard.hashMode === 'PROTOBUF_V1'
  const sharder = customSharder ?? new MD5Sharder()
  const assignedShard = sharder.getShard(
    protobufV1 ? `${shard.salt}${subjectKey}` : hashKey(shard.salt, subjectKey),
    shard.totalShards
  )
  return shard.ranges.some((range) => isInShardRange(assignedShard, range))
}

function isInShardRange(shard: number, range: ShardRange): boolean {
  return range.start <= shard && shard < range.end
}

function hashKey(salt: string, subjectKey: string): string {
  return `${salt}-${subjectKey}`
}
