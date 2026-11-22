/** Shared pg pool for the dashboard's own tables (auth_users, auth_sessions). Server only. */
import pg from 'pg';
import { ConfigError, getConfig } from './config.js';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const { databaseUrl } = getConfig();
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is not set');
  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
    application_name: 'tidepool-dashboard',
  });
  pool.on('error', (err) => {
    // Idle client errors must not crash the server; log without connection details.
    console.error('[dashboard] postgres pool error:', err.message);
  });
  return pool;
}
