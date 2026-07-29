// Protobuf descriptors initialize during import, so configure non-browser runtimes first.
import './protobuf-text-encoding'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { base64Decode, base64Encode } from '@bufbuild/protobuf/wire'
import { type FlagsConfiguration, FlagsConfigurationSchema } from './generated/ufc_pb'

export function decodeUniversalFlagConfiguration(response: string): FlagsConfiguration {
  return fromBinary(FlagsConfigurationSchema, base64Decode(response))
}

export function encodeUniversalFlagConfiguration(configuration: FlagsConfiguration): string {
  return base64Encode(toBinary(FlagsConfigurationSchema, configuration))
}
