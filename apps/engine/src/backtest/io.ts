/** Bounded, validated JSONL reading and writing for backtest inputs and fixtures. */
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { z } from 'zod';

export interface ReadJsonlOptions {
  maxLineBytes?: number;
  maxLines?: number;
}

export async function readJsonl<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  opts: ReadJsonlOptions = {},
): Promise<z.infer<S>[]> {
  const maxLineBytes = opts.maxLineBytes ?? 1_000_000;
  const maxLines = opts.maxLines ?? 5_000_000;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  const out: z.infer<S>[] = [];
  let n = 0;
  for await (const line of rl) {
    n += 1;
    if (n > maxLines) throw new Error(`${path}: more than ${maxLines} lines`);
    if (line.length > maxLineBytes) throw new Error(`${path}:${n}: line exceeds ${maxLineBytes} bytes`);
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new Error(`${path}:${n}: invalid JSON`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`${path}:${n}: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'invalid record'}`);
    }
    out.push(parsed.data as z.infer<S>);
  }
  return out;
}

export async function writeJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
