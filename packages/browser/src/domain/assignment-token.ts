import type { EvaluationContext } from '@openfeature/web-sdk'
import { GeneralError } from '@openfeature/web-sdk'

export const ASSIGNMENT_AUTHORIZATION_FAILED = 'ASSIGNMENT_AUTHORIZATION_FAILED'
export const ASSIGNMENT_TOKEN_HEADER = 'DD-Assignment-Token'

// This is only a client-side optimization. Fastly enforces the actual expiry.
const EXPIRATION_CLOCK_SKEW_SECONDS = 60

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
  let expiresAt: unknown
  try {
    const parts = value.split('.')
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
      expiresAt = payload?.exp
    }
  } catch {
    // Malformed JWT strings and missing/invalid exp remain Fastly's decision.
  }
  if (
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    expiresAt <= Date.now() / 1000 - EXPIRATION_CLOCK_SKEW_SECONDS
  ) {
    throw assignmentAuthorizationError()
  }
  return value
}
