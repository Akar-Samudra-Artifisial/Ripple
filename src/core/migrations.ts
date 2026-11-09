/**
 * Forge SQL schema, applied in order by the `schema-migrate` consumer. Forge SQL runs MySQL-compatible SQL, one
 * statement per query and without foreign keys, so referential integrity is enforced in code.
 * Append-only: never edit or reorder an applied migration; add a new one (one ADD per ALTER, always IF NOT EXISTS).
 */
export const MIGRATIONS: readonly { name: string; statement: string }[] = [
  {
    name: 'v001_create_settings',
    statement: `CREATE TABLE IF NOT EXISTS settings (
      k VARCHAR(64) PRIMARY KEY,
      v JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  },
  // Audit trail (NFR-7): who did what to which object, and when. `detail` holds ids and short quotes only.
  {
    name: 'v002_create_audit',
    statement: `CREATE TABLE IF NOT EXISTS audit (
      id VARCHAR(36) PRIMARY KEY,
      action VARCHAR(48) NOT NULL,
      actor_account_id VARCHAR(128) NULL,
      subject_type VARCHAR(32) NOT NULL,
      subject_id VARCHAR(64) NOT NULL,
      detail JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_subject (subject_type, subject_id, created_at),
      KEY idx_audit_created (created_at)
    )`,
  },
];

/** Name of the newest migration; the byline reports it so admins can confirm the schema is current. */
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? '';
