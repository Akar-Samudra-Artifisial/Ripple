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
  // Identity key as first extracted; a reviewer edit changes identity_key but not this, so re-extraction still
  // matches the edited fact instead of proposing it again. NULL on rows from before v005 (falls back to identity_key).
  { name: 'v005_facts_origin_key', statement: 'ALTER TABLE facts ADD COLUMN IF NOT EXISTS origin_key VARCHAR(400) NULL' },
  // Page text was longer than the LLM input limit, so facts past the cut were not read.
  { name: 'v006_sources_text_truncated', statement: 'ALTER TABLE sources ADD COLUMN IF NOT EXISTS text_truncated TINYINT(1) NOT NULL DEFAULT 0' },
  // Copy scans (FR-4..6, NFR-6): one row per scan of a source; `fact_cursor` and the `scan_hits` rows let the
  // `search` and `judge` consumers resume from the last finished batch. `terms` = search terms per fact (JSON).
  {
    name: 'v007_create_scan_jobs',
    statement: `CREATE TABLE IF NOT EXISTS scan_jobs (
      id VARCHAR(36) PRIMARY KEY,
      source_page_id VARCHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL,
      facts_total INT NOT NULL DEFAULT 0,
      fact_cursor INT NOT NULL DEFAULT 0,
      terms JSON NULL,
      candidates INT NOT NULL DEFAULT 0,
      pages_judged INT NOT NULL DEFAULT 0,
      requested_by VARCHAR(128) NULL,
      error VARCHAR(255) NULL,
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_scan_jobs_source (source_page_id, started_at)
    )`,
  },
  // Candidate pages of a scan per fact (CQL hit, at most 200 per fact). `status` pending → done once judged.
  {
    name: 'v008_create_scan_hits',
    statement: `CREATE TABLE IF NOT EXISTS scan_hits (
      scan_id VARCHAR(36) NOT NULL,
      fact_id VARCHAR(36) NOT NULL,
      page_id VARCHAR(32) NOT NULL,
      title VARCHAR(255) NULL,
      page_url VARCHAR(500) NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      PRIMARY KEY (scan_id, fact_id, page_id),
      KEY idx_scan_hits_pending (scan_id, status, page_id)
    )`,
  },
  // Copies of a fact on another page (one row per fact and page), with the judged status and a verified quote.
  {
    name: 'v009_create_copies',
    statement: `CREATE TABLE IF NOT EXISTS copies (
      id VARCHAR(36) PRIMARY KEY,
      source_page_id VARCHAR(32) NOT NULL,
      fact_id VARCHAR(36) NOT NULL,
      page_id VARCHAR(32) NOT NULL,
      page_title VARCHAR(255) NULL,
      page_url VARCHAR(500) NULL,
      page_version INT NULL,
      status VARCHAR(16) NOT NULL,
      stated_value VARCHAR(300) NULL,
      stated_unit VARCHAR(40) NULL,
      stated_condition VARCHAR(160) NULL,
      mention VARCHAR(16) NOT NULL,
      quote TEXT NOT NULL,
      reason VARCHAR(255) NOT NULL,
      scan_id VARCHAR(36) NOT NULL,
      judged_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_copies_fact_page (fact_id, page_id),
      KEY idx_copies_source_status (source_page_id, status)
    )`,
  },
  // Fact ids of a scan, fixed when it starts (the search cursor indexes into this list, not the live facts).
  { name: 'v010_scan_jobs_fact_ids', statement: 'ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS fact_ids JSON NULL' },
  // LLM calls used by a scan (capped per scan) and whether the cap stopped it early.
  { name: 'v011_scan_jobs_llm_calls', statement: 'ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS llm_calls INT NOT NULL DEFAULT 0' },
  { name: 'v012_scan_jobs_partial', statement: 'ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS partial TINYINT(1) NOT NULL DEFAULT 0' },
  // Candidate pages skipped because they could not be read or judged (403, unusable model answer).
  { name: 'v013_scan_jobs_pages_skipped', statement: 'ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS pages_skipped INT NOT NULL DEFAULT 0' },
  // Source page id while the scan runs, NULL once finished: the unique index allows one running scan per source.
  { name: 'v014_scan_jobs_active_source', statement: 'ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS active_source VARCHAR(32) NULL' },
  { name: 'v015_scan_jobs_active_unique', statement: 'ALTER TABLE scan_jobs ADD UNIQUE INDEX IF NOT EXISTS uq_scan_jobs_active (active_source)' },
  // Judge result per chunk of a candidate page, so a retry continues with the chunks not judged yet.
  {
    name: 'v016_create_scan_chunks',
    statement: `CREATE TABLE IF NOT EXISTS scan_chunks (
      scan_id VARCHAR(36) NOT NULL,
      page_id VARCHAR(32) NOT NULL,
      chunk_hash VARCHAR(64) NOT NULL,
      result JSON NOT NULL,
      PRIMARY KEY (scan_id, page_id, chunk_hash)
    )`,
  },
];

/** Name of the newest migration; the byline reports it so admins can confirm the schema is current. */
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? '';
