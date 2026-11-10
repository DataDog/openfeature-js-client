import { display } from '@datadog/browser-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { GeneralError } from '@openfeature/web-sdk'

export const ASSIGNMENT_AUTHORIZATION_FAILED = 'ASSIGNMENT_AUTHORIZATION_FAILED'
export const ASSIGNMENT_TOKEN_HEADER = 'DD-Assignment-Token'

export function extractAssignmentToken(context: EvaluationContext): {
  context: EvaluationContext
  assignmentToken: unknown
} {
  const { dd_assignment_token: assignmentToken, ...targetingContext } = context
  return { context: targetingContext, assignmentToken }
}

export function assignmentAuthorizationError(): GeneralError {
  // Never include credentials or untrusted server response details in errors.
  return new GeneralError(ASSIGNMENT_AUTHORIZATION_FAILED)
}

export function normalizeAssignmentToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  // Omit unusable values without exposing them to browser/transport diagnostics.
  // The endpoint decides whether a credential is required for this environment.
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
    display.warn(
      'Assignment token omitted: expected a string containing only printable ASCII characters without whitespace. Continuing without an assignment token.'
    )
    return undefined
  }
  // Treat JWT contents as opaque: the assignment endpoint validates claims,
  // including expiration, without relying on the customer's device clock.
  return value
}
