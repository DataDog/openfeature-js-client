// Protobuf descriptors initialize during import, so configure non-browser runtimes first.
import './protobuf-text-encoding'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import type { Logger } from '@openfeature/core'
import { type FlagsConfiguration, FlagsConfigurationSchema } from './generated/ufc_pb'
import { type PreparedRulesResponse, prepareRulesResponse } from './prepared-rules-response'

export function decodeFlagsConfiguration(
  response: Uint8Array,
  logger: Pick<Logger, 'warn'> = console
): PreparedRulesResponse {
  return prepareRulesResponse(fromBinary(FlagsConfigurationSchema, response), logger)
}

export function encodeFlagsConfiguration(configuration: FlagsConfiguration): Uint8Array {
  return toBinary(FlagsConfigurationSchema, configuration)
}
