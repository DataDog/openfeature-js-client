import { AbstractAssignmentCache } from '@datadog/flagging-core'

import type { BulkReadAssignmentCache, BulkWriteAssignmentCache } from './hybrid-assignment-cache'
import { LocalStorageAssignmentShim } from './local-storage-assignment-shim'

export class LocalStorageAssignmentCache
  extends AbstractAssignmentCache<LocalStorageAssignmentShim>
  implements BulkReadAssignmentCache, BulkWriteAssignmentCache
{
  constructor(storageKeySuffix: string) {
    super(new LocalStorageAssignmentShim(storageKeySuffix))
  }

  setEntries(entries: [string, string][]): void {
    entries.forEach(([key, value]) => {
      if (key != null && value != null) {
        this.delegate.set(key, value)
      }
    })
  }

  getEntries(): Promise<[string, string][]> {
    return Promise.resolve(Array.from(this.entries()))
  }
}
