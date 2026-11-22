/**
 * Pure authorization rules shared by pages and route handlers.
 * Owner (Jake): his home view, money-moving and live-mode actions.
 * Operator (Roe): the home view (read and run controls) and the operations view, clear halt.
 */

export type Role = 'owner' | 'operator';

export interface Viewer {
  userId: string;
  username: string;
  role: Role;
  totpEnabled: boolean;
  /** Demo viewers see every page with fixture data; every mutating action is refused. */
  demo: boolean;
}

export interface AccessRule {
  roles: readonly Role[];
  /** True for the few endpoints a user may reach before enrolling TOTP (enrollment itself). */
  allowWithoutTotp?: boolean;
  mutating?: boolean;
}

export type AccessDecision =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403;
      code: 'unauthenticated' | 'totp_enrollment_required' | 'forbidden' | 'demo_read_only';
    };

export function authorize(viewer: Viewer | null, rule: AccessRule): AccessDecision {
  if (!viewer) return { ok: false, status: 401, code: 'unauthenticated' };
  if (viewer.demo) {
    return rule.mutating ? { ok: false, status: 403, code: 'demo_read_only' } : { ok: true };
  }
  if (!viewer.totpEnabled && !rule.allowWithoutTotp)
    return { ok: false, status: 403, code: 'totp_enrollment_required' };
  if (!rule.roles.includes(viewer.role)) return { ok: false, status: 403, code: 'forbidden' };
  return { ok: true };
}

export const PAGE_RULES = {
  home: { roles: ['owner', 'operator'] },
  ops: { roles: ['operator'] },
  security: { roles: ['owner', 'operator'], allowWithoutTotp: true },
} as const satisfies Record<string, AccessRule>;

export type PageName = keyof typeof PAGE_RULES;

/** Where a page request should go instead, or null to render it. */
export function pageRedirect(viewer: Viewer | null, page: PageName): string | null {
  const d = authorize(viewer, PAGE_RULES[page]);
  if (d.ok) return null;
  switch (d.code) {
    case 'unauthenticated':
      return '/login';
    case 'totp_enrollment_required':
      return '/settings/security';
    default:
      return page === 'home' ? '/settings/security' : '/';
  }
}

export function friendlyAccessError(code: Exclude<AccessDecision, { ok: true }>['code']): string {
  switch (code) {
    case 'unauthenticated':
      return 'Your session has ended. Sign in again.';
    case 'totp_enrollment_required':
      return 'Set up two-factor sign-in before using the dashboard.';
    case 'forbidden':
      return 'Your account is not allowed to do that.';
    case 'demo_read_only':
      return 'Demo mode is read only. Actions are disabled.';
  }
}
