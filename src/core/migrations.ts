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
  // Source-of-truth pages (FR-1). One row per marked page; unmarking deletes the row and its facts.
  {
    name: 'v003_create_sources',
    statement: `CREATE TABLE IF NOT EXISTS sources (
      page_id VARCHAR(32) PRIMARY KEY,
      space_id VARCHAR(32) NULL,
      title VARCHAR(255) NULL,
      status VARCHAR(16) NOT NULL,
      page_version INT NULL,
      page_version_at VARCHAR(40) NULL,
      marked_by VARCHAR(128) NOT NULL,
      marked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      extract_job VARCHAR(64) NULL,
      extracted_at TIMESTAMP NULL,
      extract_error VARCHAR(255) NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_sources_space (space_id)
    )`,
  },
  // Facts of a source page (FR-2/3). Identity key = normalised subject + attribute + condition, unique per page.
  // `fact_condition` because CONDITION is a reserved word in MySQL.
  {
    name: 'v004_create_facts',
    statement: `CREATE TABLE IF NOT EXISTS facts (
      id VARCHAR(36) PRIMARY KEY,
      source_page_id VARCHAR(32) NOT NULL,
      identity_key VARCHAR(400) NOT NULL,
      fact_type VARCHAR(16) NOT NULL,
      subject VARCHAR(160) NOT NULL,
      attribute VARCHAR(160) NOT NULL,
      value VARCHAR(300) NOT NULL,
      unit VARCHAR(40) NULL,
      fact_condition VARCHAR(160) NULL,
      quote TEXT NOT NULL,
      status VARCHAR(16) NOT NULL,
      edited TINYINT(1) NOT NULL DEFAULT 0,
      previous_value VARCHAR(300) NULL,
      page_version INT NOT NULL,
      effective_since VARCHAR(40) NULL,
      reviewed_by VARCHAR(128) NULL,
      reviewed_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_facts_identity (source_page_id, identity_key),
      KEY idx_facts_source_status (source_page_id, status)
    )`,
  },
];

/** Name of the newest migration; the byline reports it so admins can confirm the schema is current. */
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? '';
