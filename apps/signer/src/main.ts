import { loadConfig } from './config.js';
import { loadKeystore } from './keystore.js';
import { promptHidden } from './prompt.js';
import { createSignerServer, jsonLineLogger } from './server.js';
import { SignerStateStore } from './state.js';

/**
 * Signer entry point. Loads configuration, decrypts the keystore once, then serves POST /sign on a
 * loopback address. The passphrase is removed from the process environment as soon as it is read.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  let passphrase = process.env.SIGNER_KEYSTORE_PASSPHRASE ?? '';
  delete process.env.SIGNER_KEYSTORE_PASSPHRASE;
  if (!passphrase) {
    if (!process.stdin.isTTY) throw new Error('SIGNER_KEYSTORE_PASSPHRASE is not set and no terminal is available');
    passphrase = await promptHidden('Keystore passphrase: ');
  }
  const keypair = loadKeystore(config.keystorePath, passphrase);
  // eslint-disable-next-line no-useless-assignment -- drop the passphrase reference as soon as it is used
  passphrase = '';
  const state = SignerStateStore.open(config.statePath);
  const signer = createSignerServer({ config, keypair, state, logger: jsonLineLogger });
  const addr = await signer.listen();
  jsonLineLogger({
    event: 'signer_started',
    publicKey: keypair.publicKey.toBase58(),
    host: addr.host,
    port: addr.port,
    maxPerTxLamports: config.policy.maxPerTxLamports.toString(),
    maxPerDayLamports: config.maxPerDayLamports.toString(),
    maxTipLamports: config.policy.maxTipLamports.toString(),
    tipAccounts: config.policy.tipAccounts.length,
    withdrawAllowlist: config.policy.withdrawAllowlist,
  });

  const shutdown = (signal: string) => {
    jsonLineLogger({ event: 'signer_stopping', signal });
    void signer.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  jsonLineLogger({ event: 'signer_fatal', message: err instanceof Error ? err.message : 'unknown failure' });
  process.exit(1);
});
