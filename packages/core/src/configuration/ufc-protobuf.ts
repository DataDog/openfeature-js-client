// Protobuf descriptors initialize during import, so configure non-browser runtimes first.
import './protobuf-text-encoding'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { base64Decode, base64Encode } from '@bufbuild/protobuf/wire'
import { type FlagsConfiguration, FlagsConfigurationSchema } from './generated/ufc_pb'
import { type PreparedRulesResponse, prepareRulesResponse } from './prepared-rules-response'

export function decodeUniversalFlagConfiguration(response: string): PreparedRulesResponse {
  return decodeUniversalFlagConfigurationBinary(base64Decode(response))
}

export function decodeUniversalFlagConfigurationBinary(response: Uint8Array): PreparedRulesResponse {
  return prepareRulesResponse(fromBinary(FlagsConfigurationSchema, response))
}

export function encodeUniversalFlagConfiguration(configuration: FlagsConfiguration): string {
  return base64Encode(toBinary(FlagsConfigurationSchema, configuration))
}
