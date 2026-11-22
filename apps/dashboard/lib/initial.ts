/** Server-side first render data, so pages show real numbers before the first poll. Server only. */
import { PRESETS, type PresetName, type StatusDto } from '@tidepool/core';
import type { Viewer } from './auth/guard.js';
import { getConfig } from './config.js';
import { demoStatus } from './demo.js';
import { engineRequest } from './engine.js';
import type { PresetSummary } from './labels.js';

export async function loadInitialStatus(viewer: Viewer): Promise<{ status: StatusDto | null; error: string | null }> {
  try {
    if (getConfig().demoMode) return { status: demoStatus(), error: null };
    const r = await engineRequest<StatusDto>({ method: 'GET', path: '/status', viewer });
    return r.ok ? { status: r.data, error: null } : { status: null, error: r.message };
  } catch {
    return { status: null, error: 'The dashboard could not load the engine status.' };
  }
}

export function presetSummaries(): PresetSummary[] {
  return (Object.keys(PRESETS) as PresetName[]).map((name) => {
    const p = PRESETS[name];
    return {
      name,
      label: p.label,
      description: p.description,
      maxPositionPct: p.limits.maxPositionBps / 100,
      maxOpenPositions: p.limits.maxOpenPositions,
      dailyLossLimitPct: p.limits.dailyLossLimitBps / 100,
    };
  });
}

export function publicViewer(v: Viewer): {
  username: string;
  role: Viewer['role'];
  demo: boolean;
  totpEnabled: boolean;
} {
  return { username: v.username, role: v.role, demo: v.demo, totpEnabled: v.totpEnabled };
}
