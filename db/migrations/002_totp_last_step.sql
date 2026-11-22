-- Persist the last accepted TOTP time step per user so a code cannot be replayed across dashboard restarts.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS totp_last_step bigint NULL;
