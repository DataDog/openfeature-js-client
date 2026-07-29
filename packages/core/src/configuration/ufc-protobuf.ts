// Protobuf descriptors initialize during import, so configure non-browser runtimes first.
import './protobuf-text-encoding'
import { fromBinary } from '@bufbuild/protobuf'
import { base64Decode } from '@bufbuild/protobuf/wire'
import { type FlagsConfiguration, FlagsConfigurationSchema } from './generated/ufc_pb'

export function decodeUniversalFlagConfiguration(response: string): FlagsConfiguration {
  return fromBinary(FlagsConfigurationSchema, base64Decode(response))
}
