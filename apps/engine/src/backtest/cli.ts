/**
 * Backtest CLI.
 *
 *   npm run backtest -- --signals signals.jsonl --prices prices.jsonl --preset balanced
 *   npm run backtest -- --signals s.jsonl --prices p.jsonl --sol-prices sol.jsonl --walk-forward --split 2026-11-01
 *   npm run backtest -- --synthetic-demo [--walk-forward --split 2026-10-30] [--write-fixture data/recordings/synthetic]
 *
 * Writes <name>.json and <name>.md to data/reports/ (or --out). Output from synthetic data is labeled synthetic
 * in the file name, the title and every report.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { PresetName } from '@tidepool/core';
import { generateSyntheticFixture } from './fixtures.js';
import { readJsonl, writeJsonl } from './io.js';
import { runBacktest } from './replay.js';
import { reportToJson, reportToMarkdown } from './report.js';
import { looksSynthetic, PricePointSchema, SignalEventSchema, SolPricePointSchema, type BacktestInput } from './types.js';
import { walkForward } from './walkForward.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

const USAGE = `usage: backtest (--signals FILE --prices FILE | --synthetic-demo) [--preset conservative|balanced|aggressive]
                [--sol-prices FILE] [--sol-usd N] [--equity-sol N] [--seed N] [--failure-rate X]
                [--walk-forward --split YYYY-MM-DD] [--out DIR] [--write-fixture DIR]`;

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      signals: { type: 'string' },
      prices: { type: 'string' },
      'sol-prices': { type: 'string' },
      'sol-usd': { type: 'string' },
      preset: { type: 'string', default: 'balanced' },
      'equity-sol': { type: 'string', default: '10' },
      seed: { type: 'string', default: '1' },
      'failure-rate': { type: 'string' },
      'walk-forward': { type: 'boolean', default: false },
      split: { type: 'string' },
      out: { type: 'string' },
      'synthetic-demo': { type: 'boolean', default: false },
      'write-fixture': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) { console.log(USAGE); return 0; }
  const preset = values.preset as PresetName;
  if (!['conservative', 'balanced', 'aggressive'].includes(preset)) throw new Error(`unknown preset ${preset}`);
  const seed = Number(values.seed);
  const equitySol = Number(values['equity-sol']);
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');
  if (!(equitySol > 0)) throw new Error('--equity-sol must be positive');
  const failureRate = values['failure-rate'] !== undefined ? Number(values['failure-rate']) : undefined;
  const solUsd = values['sol-usd'] !== undefined ? Number(values['sol-usd']) : undefined;

  let input: BacktestInput;
  if (values['synthetic-demo']) {
    const f = generateSyntheticFixture({ seed: seed === 1 ? 42 : seed });
    input = f;
    if (values['write-fixture']) {
      const dir = resolve(values['write-fixture']);
      await writeJsonl(join(dir, 'synthetic-signals.jsonl'), f.signals);
      await writeJsonl(join(dir, 'synthetic-prices.jsonl'), f.prices);
      await writeJsonl(join(dir, 'synthetic-sol-prices.jsonl'), f.solPrices);
      console.log(`wrote synthetic fixture to ${dir}`);
    }
  } else {
    if (!values.signals || !values.prices) { console.error(USAGE); return 2; }
    input = {
      signals: await readJsonl(resolve(values.signals), SignalEventSchema),
      prices: await readJsonl(resolve(values.prices), PricePointSchema),
    };
    if (values['sol-prices']) input.solPrices = await readJsonl(resolve(values['sol-prices']), SolPricePointSchema);
  }
  const synthetic = values['synthetic-demo'] || looksSynthetic(input);
  const base = {
    preset,
    seed,
    startingLamports: BigInt(Math.round(equitySol * 1e9)),
    synthetic,
    ...(failureRate !== undefined ? { failureRate } : {}),
    ...(solUsd !== undefined ? { defaultSolUsd: solUsd } : {}),
  };

  const outDir = resolve(values.out ?? join(REPO_ROOT, 'data/reports'));
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `${synthetic ? 'synthetic-' : ''}${values['walk-forward'] ? 'walkforward' : 'backtest'}-${preset}-${stamp}`;

  if (values['walk-forward']) {
    if (!values.split) throw new Error('--walk-forward requires --split YYYY-MM-DD');
    const split = new Date(`${values.split}T00:00:00Z`);
    if (!Number.isFinite(split.getTime())) throw new Error('invalid --split date');
    const r = await walkForward(input, { ...base, split });
    const md = [
      reportToMarkdown(r.test, `Walk-forward test window (chosen params ${JSON.stringify(r.tune.chosen)})`),
      reportToMarkdown(r.baselineTest, 'Walk-forward test window (preset defaults, baseline)'),
      `## Tuning (window ${r.tune.window.from} to ${r.tune.window.to}, latest input ${r.tune.maxInputAt}, split ${r.split})`,
      '',
      r.tune.chosenFromGrid ? '' : 'No grid point reached the minimum trade count; preset defaults were used.',
      '| Params | Trades | Net after costs (lamports) | Max DD % |', '| --- | --- | --- | --- |',
      ...r.tune.results.map((x) => `| ${JSON.stringify(x.params)} | ${x.trades} | ${x.netAfterAllCostsLamports} | ${x.maxDrawdownPct.toFixed(2)} |`),
      '',
    ].join('\n');
    await writeFile(join(outDir, `${prefix}.json`), reportToJson(r), 'utf8');
    await writeFile(join(outDir, `${prefix}.md`), md, 'utf8');
  } else {
    const r = await runBacktest(input, base);
    await writeFile(join(outDir, `${prefix}.json`), reportToJson(r), 'utf8');
    await writeFile(join(outDir, `${prefix}.md`), reportToMarkdown(r), 'utf8');
    console.log(`${synthetic ? '[SYNTHETIC] ' : ''}trades=${r.summary.trades} net=${r.summary.netAfterAllCostsLamports} lamports maxDD=${r.summary.maxDrawdownPct.toFixed(2)}%`);
  }
  console.log(`wrote ${join(outDir, prefix)}.{json,md}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
