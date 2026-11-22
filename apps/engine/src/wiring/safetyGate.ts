import type { Candidate } from '@tidepool/core';
import type { RiskOfficer, ReservationRequest, ReservationDecision, SafetyChecker } from '../contracts.js';

/**
 * Wraps the Risk Officer so every reservation is judged on token safety facts fetched fresh at
 * request time (authorities, Token-2022 extensions, holder concentration and a sell simulation
 * for the exact size), rather than on the copy the Scout attached when it ranked the token.
 * If the fresh check fails for any reason the request is vetoed (fail closed).
 */
export function withFreshSafety(
  risk: RiskOfficer,
  checker: SafetyChecker,
  onError?: (mint: string, err: unknown) => void,
): RiskOfficer {
  const reserve = async (req: ReservationRequest): Promise<ReservationDecision> => {
    let fresh;
    try {
      fresh = await checker.check(req.mint, req.lamports);
    } catch (err) {
      onError?.(req.mint, err);
      return { approved: false, reason: 'safety:recheck_failed' };
    }
    if (!fresh || fresh.mint !== req.mint) return { approved: false, reason: 'safety:recheck_mismatch' };
    const candidate: Candidate = { ...req.candidate, safety: fresh };
    return risk.reserve({ ...req, candidate });
  };
  return new Proxy(risk, {
    get(target, prop, receiver) {
      if (prop === 'reserve') return reserve;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}
