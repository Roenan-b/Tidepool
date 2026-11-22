import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  anchorEventDiscriminator,
  decodePumpEvent,
  parseLogNotification,
  PUMP_FUN_PROGRAM_ID,
  PUMP_SWAP_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
} from './heliusParser.js';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const MINT = key(11);
const CURVE = key(12);
const USER = key(13);
const CREATOR = key(14);
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const EVIL = key(99).toBase58();

function borshString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

function createEventB64(withCreator = true): string {
  return Buffer.concat([
    anchorEventDiscriminator('CreateEvent'),
    borshString('Dog Coin'),
    borshString('DOG'),
    borshString('https://ipfs.example/dog.json'),
    MINT.toBuffer(),
    CURVE.toBuffer(),
    USER.toBuffer(),
    ...(withCreator ? [CREATOR.toBuffer(), Buffer.alloc(8)] : []),
  ]).toString('base64');
}

function completeEventB64(): string {
  return Buffer.concat([
    anchorEventDiscriminator('CompleteEvent'),
    USER.toBuffer(),
    MINT.toBuffer(),
    CURVE.toBuffer(),
    Buffer.alloc(8),
  ]).toString('base64');
}

const createLogs = (data: string) => [
  `Program ${COMPUTE} invoke [1]`,
  `Program ${COMPUTE} success`,
  `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`,
  'Program log: Instruction: Create',
  'Program 11111111111111111111111111111111 invoke [2]',
  'Program 11111111111111111111111111111111 success',
  `Program data: ${data}`,
  `Program ${PUMP_FUN_PROGRAM_ID} consumed 120000 of 200000 compute units`,
  `Program ${PUMP_FUN_PROGRAM_ID} success`,
];

describe('decodePumpEvent', () => {
  it('decodes CreateEvent including the optional creator', () => {
    const ev = decodePumpEvent(createEventB64())!;
    expect(ev.event).toBe('create');
    expect(ev.mint).toBe(MINT.toBase58());
    expect(ev.details).toMatchObject({
      name: 'Dog Coin',
      symbol: 'DOG',
      bondingCurve: CURVE.toBase58(),
      user: USER.toBase58(),
      creator: CREATOR.toBase58(),
    });
  });

  it('decodes the older CreateEvent layout without a creator', () => {
    const ev = decodePumpEvent(createEventB64(false))!;
    expect(ev.details.creator).toBeUndefined();
    expect(ev.mint).toBe(MINT.toBase58());
  });

  it('decodes CompleteEvent', () => {
    expect(decodePumpEvent(completeEventB64())).toMatchObject({ event: 'complete', mint: MINT.toBase58() });
  });

  it('returns null for truncated, oversized or unknown data', () => {
    const full = Buffer.from(createEventB64(), 'base64');
    expect(decodePumpEvent(full.subarray(0, 60).toString('base64'))).toBeNull();
    const huge = Buffer.concat([
      anchorEventDiscriminator('CreateEvent'),
      Buffer.from([0xff, 0xff, 0xff, 0x7f]),
      Buffer.alloc(64),
    ]);
    expect(decodePumpEvent(huge.toString('base64'))).toBeNull();
    expect(decodePumpEvent(Buffer.alloc(80, 1).toString('base64'))).toBeNull();
  });
});

describe('parseLogNotification', () => {
  it('extracts a new token from a pump.fun create transaction', () => {
    const out = parseLogNotification({ signature: 'sig1', err: null, logs: createLogs(createEventB64()) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'new_token',
      mint: MINT.toBase58(),
      signature: 'sig1',
      program: PUMP_FUN_PROGRAM_ID,
    });
  });

  it('ignores failed transactions', () => {
    expect(
      parseLogNotification({
        signature: 's',
        err: { InstructionError: [0, 'Custom'] },
        logs: createLogs(createEventB64()),
      }),
    ).toEqual([]);
  });

  it('does not trust event data printed by another program in the same transaction', () => {
    const logs = [
      `Program ${EVIL} invoke [1]`,
      'Program log: Instruction: Create',
      `Program data: ${createEventB64()}`,
      `Program ${EVIL} success`,
    ];
    expect(parseLogNotification({ signature: 's', err: null, logs })).toEqual([]);
  });

  it('emits only the signature when the instruction is seen but the mint is not in the logs', () => {
    const logs = [
      `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`,
      'Program log: Instruction: Create',
      `Program ${PUMP_FUN_PROGRAM_ID} success`,
    ];
    const out = parseLogNotification({ signature: 'sig2', err: null, logs });
    expect(out).toEqual([
      {
        kind: 'unresolved_tx',
        program: PUMP_FUN_PROGRAM_ID,
        instruction: 'Create',
        signature: 'sig2',
        mint: null,
        details: { intendedKind: 'new_token' },
      },
    ]);
  });

  it('reports Raydium v4 initialize2 and PumpSwap CreatePool as unresolved pools', () => {
    const logs = [
      `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
      'Program log: initialize2: InitializeInstruction2 { nonce: 254, open_time: 0, init_pc_amount: 1, init_coin_amount: 2 }',
      `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      `Program ${PUMP_SWAP_PROGRAM_ID} invoke [1]`,
      'Program log: Instruction: CreatePool',
      `Program ${PUMP_SWAP_PROGRAM_ID} success`,
    ];
    const out = parseLogNotification({ signature: 'sig3', err: null, logs });
    expect(out.map((o) => [o.kind, o.instruction, o.mint])).toEqual([
      ['unresolved_tx', 'initialize2', null],
      ['unresolved_tx', 'CreatePool', null],
    ]);
  });

  it('detects a curve completion as a migration with its mint', () => {
    const logs = [
      `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`,
      'Program log: Instruction: Buy',
      `Program data: ${completeEventB64()}`,
      `Program ${PUMP_FUN_PROGRAM_ID} success`,
    ];
    const out = parseLogNotification({ signature: 'sig4', err: null, logs });
    expect(out).toEqual([expect.objectContaining({ kind: 'migration', mint: MINT.toBase58() })]);
  });

  it('ignores ordinary swaps and respects the configured program list', () => {
    const swap = [
      `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`,
      'Program log: Instruction: Sell',
      `Program ${PUMP_FUN_PROGRAM_ID} success`,
    ];
    expect(parseLogNotification({ signature: 's', err: null, logs: swap })).toEqual([]);
    expect(
      parseLogNotification({ signature: 's', err: null, logs: createLogs(createEventB64()) }, [
        RAYDIUM_AMM_V4_PROGRAM_ID,
      ]),
    ).toEqual([]);
  });
});
