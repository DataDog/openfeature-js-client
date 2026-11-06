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

export function validateAssignmentToken(value: unknown): string | undefined {
  if (value === undefined) return undefined
  // JWTs are ASCII without whitespace. Reject invalid header values without
  // letting the browser or a transport wrapper echo the value in an error.
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
    throw assignmentAuthorizationError()
  }
  // Treat JWT contents as opaque: the assignment endpoint validates claims,
  // including expiration, without relying on the customer's device clock.
  return value
}
