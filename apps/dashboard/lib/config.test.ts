import { describe, expect, it } from 'vitest';
import { ConfigError, demoModeRefusal, loadConfig, parseEncryptionKey } from './config.js';

const key = Buffer.alloc(32, 7).toString('base64');

describe('loadConfig', () => {
  it('loads defaults for local development', () => {
    const c = loadConfig({ NODE_ENV: 'development', AUTH_ENCRYPTION_KEY: key });
    expect(c.dashboardOrigin).toBe('http://127.0.0.1:3000');
    expect(c.secureCookies).toBe(false);
    expect(c.engineToken).toBeNull();
    expect(c.authEncryptionKey).toHaveLength(32);
  });

  it('requires https for non-loopback origins and engine URLs', () => {
    expect(() => loadConfig({ DASHBOARD_ORIGIN: 'http://dash.example.test' })).toThrow(ConfigError);
    expect(loadConfig({ DASHBOARD_ORIGIN: 'https://dash.example.test' }).secureCookies).toBe(true);
    expect(() => loadConfig({ ENGINE_URL: 'http://10.0.0.5:7070' })).toThrow(ConfigError);
    expect(() => loadConfig({ DASHBOARD_ORIGIN: 'https://dash.example.test/path' })).toThrow(ConfigError);
  });

  it('treats the placeholder engine token as unset and rejects short tokens', () => {
    expect(loadConfig({ ENGINE_API_TOKEN: 'replace-with-64-hex-chars' }).engineToken).toBeNull();
    expect(() => loadConfig({ ENGINE_API_TOKEN: 'short' })).toThrow(ConfigError);
  });

  it('validates the encryption key length', () => {
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(ConfigError);
    expect(() => parseEncryptionKey('not base64!')).toThrow(ConfigError);
  });
});

describe('demo mode safety', () => {
  it('is allowed in development', () => {
    expect(demoModeRefusal({ DEMO_MODE: 'true', NODE_ENV: 'development' })).toBeNull();
  });
  it('is refused in production on a non-loopback origin or with real credentials', () => {
    expect(
      demoModeRefusal({ DEMO_MODE: 'true', NODE_ENV: 'production', DASHBOARD_ORIGIN: 'https://dash.example.test' }),
    ).not.toBeNull();
    expect(
      demoModeRefusal({ DEMO_MODE: 'true', NODE_ENV: 'production', ENGINE_API_TOKEN: 'a'.repeat(64) }),
    ).not.toBeNull();
    expect(demoModeRefusal({ DEMO_MODE: 'true', NODE_ENV: 'production', DATABASE_URL: 'postgres://x' })).not.toBeNull();
    expect(() => loadConfig({ DEMO_MODE: 'true', NODE_ENV: 'production', DATABASE_URL: 'postgres://x' })).toThrow(
      ConfigError,
    );
  });
  it('allows a local production-build preview with nothing configured', () => {
    expect(demoModeRefusal({ DEMO_MODE: 'true', NODE_ENV: 'production' })).toBeNull();
    expect(loadConfig({ DEMO_MODE: 'true', NODE_ENV: 'production' }).demoMode).toBe(true);
  });
  it('only enables on the exact string "true"', () => {
    expect(loadConfig({ DEMO_MODE: '1' }).demoMode).toBe(false);
  });
});
