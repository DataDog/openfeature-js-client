// Protobuf descriptors initialize during import, so configure non-browser runtimes first.
import './protobuf-text-encoding'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { type FlagsConfiguration, FlagsConfigurationSchema } from './generated/ufc_pb'
import { type PreparedRulesResponse, prepareRulesResponse } from './prepared-rules-response'

export function decodeUniversalFlagConfiguration(response: Uint8Array): PreparedRulesResponse {
  return prepareRulesResponse(fromBinary(FlagsConfigurationSchema, response))
}

export function encodeUniversalFlagConfiguration(configuration: FlagsConfiguration): Uint8Array {
  return toBinary(FlagsConfigurationSchema, configuration)
}
