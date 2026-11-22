/** Account lockout: 5 failed password or TOTP attempts lock the account for 15 minutes. */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface LockState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

export function isLocked(state: LockState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** Returns the state after one more failure. Reaching the limit locks and resets the counter. */
export function afterFailure(state: LockState, now: Date): LockState {
  const attempts = state.failedAttempts + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    return { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) };
  }
  return { failedAttempts: attempts, lockedUntil: state.lockedUntil };
}

export function minutesRemaining(state: LockState, now: Date): number {
  if (!state.lockedUntil) return 0;
  return Math.max(0, Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 60_000));
}

/**
 * Attempt accounting that holds under concurrency. Every password or TOTP check first claims one
 * attempt (counted before the check runs), so parallel requests cannot all pass a stale "not locked"
 * read and get more than MAX_FAILED_ATTEMPTS guesses per lockout period. The PostgreSQL store runs the
 * same rules as single atomic UPDATE statements; these pure versions back the in-memory store in tests.
 */
export type ClaimResult = { allowed: true; state: LockState } | { allowed: false; state: LockState };

export function claimAttempt(state: LockState, now: Date): ClaimResult {
  if (isLocked(state, now)) return { allowed: false, state };
  if (state.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    // The budget is used up by attempts still in flight (or left behind by a crash): lock now.
    return { allowed: false, state: { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) } };
  }
  return { allowed: true, state: { failedAttempts: state.failedAttempts + 1, lockedUntil: state.lockedUntil } };
}

/** After a claimed attempt failed: lock once the claimed attempts reach the limit. */
export function settleFailure(state: LockState, now: Date): LockState {
  if (state.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    return { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) };
  }
  return state;
}

/** Gives back a claimed attempt that turned out not to be a failure (a correct password before TOTP). */
export function releaseAttempt(state: LockState, now: Date): LockState {
  if (isLocked(state, now)) return state;
  return { failedAttempts: Math.max(0, state.failedAttempts - 1), lockedUntil: state.lockedUntil };
}
