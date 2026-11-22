/** Input record shapes for the replay harness (validated with zod at the file boundary). */
import { z } from 'zod';

const IsoTime = z
  .string()
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)), 'invalid ISO time');
const Mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

/** Same shape as the signals table (camelCase): one normalized collector event. */
export const SignalEventSchema = z.object({
  source: z.string().min(1).max(64),
  mint: Mint.nullable(),
  kind: z.string().min(1).max(64),
  observedAt: IsoTime,
  payload: z.record(z.unknown()),
});
export type SignalEvent = z.infer<typeof SignalEventSchema>;

export const PricePointSchema = z.object({
  mint: Mint,
  at: IsoTime,
  priceLamportsPerUnit: z.number().finite().positive(),
  liquidityUsd: z.number().finite().nonnegative(),
  venue: z.enum(['bondingCurve', 'graduated']).optional(),
});
export type PricePoint = z.infer<typeof PricePointSchema>;

export const SolPricePointSchema = z.object({ at: IsoTime, solUsd: z.number().finite().positive() });
export type SolPricePoint = z.infer<typeof SolPricePointSchema>;

export interface BacktestInput {
  signals: SignalEvent[];
  prices: PricePoint[];
  solPrices?: SolPricePoint[];
}

/** True when any input record is marked synthetic (source prefix or payload flag). */
export function looksSynthetic(input: BacktestInput): boolean {
  return input.signals.some((s) => s.source.startsWith('synthetic') || s.payload.synthetic === true);
}
