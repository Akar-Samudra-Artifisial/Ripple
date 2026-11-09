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
  // TiDB has IF NOT EXISTS for `CREATE [UNIQUE] INDEX` and plain `ADD INDEX`, not for `ADD UNIQUE INDEX` (parse error).
  { name: 'v015_scan_jobs_active_unique', statement: 'CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_jobs_active ON scan_jobs (active_source)' },
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
  // M3 (FR-7): a detected change of a source's confirmed facts, waiting for the owner's confirmation. At most one
  // pending row per source (enforced in code); JSON columns hold ids, old/new values and per-copy page/space ids.
  {
    name: 'v017_create_changes',
    statement: `CREATE TABLE IF NOT EXISTS changes (
      id VARCHAR(36) PRIMARY KEY,
      source_page_id VARCHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL,
      page_version INT NOT NULL,
      fact_changes JSON NOT NULL,
      missing_fact_ids JSON NULL,
      impact JSON NULL,
      routing JSON NULL,
      deadline_days INT NULL,
      decided_by VARCHAR(128) NULL,
      decided_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_changes_source_status (source_page_id, status)
    )`,
  },
  // Page versions already handled by the updated:page trigger (dedup of redelivered events).
  {
    name: 'v018_create_page_events',
    statement: `CREATE TABLE IF NOT EXISTS page_events (
      page_id VARCHAR(32) NOT NULL,
      version INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (page_id, version)
    )`,
  },
  // CQL synonyms of a fact, generated once: `{ key: identity key when generated, terms: string[] }`.
  { name: 'v019_facts_search_terms', statement: 'ALTER TABLE facts ADD COLUMN IF NOT EXISTS search_terms JSON NULL' },
  // Facts of a scan whose synonyms came from the cache (scan summary log).
  { name: 'v020_scan_jobs_synonyms_cached', statement: 'ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS synonyms_cached INT NOT NULL DEFAULT 0' },
  // sha256 of the source text last read by a diff: a new version with the same text skips the LLM.
  { name: 'v021_sources_text_hash', statement: 'ALTER TABLE sources ADD COLUMN IF NOT EXISTS text_hash VARCHAR(64) NULL' },
  // Values the owner dismissed per fact (sha256 of the normalised value|unit): not raised again by later versions.
  {
    name: 'v022_create_change_dismissals',
    statement: `CREATE TABLE IF NOT EXISTS change_dismissals (
      fact_id VARCHAR(36) NOT NULL,
      value_hash VARCHAR(64) NOT NULL,
      source_page_id VARCHAR(32) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (fact_id, value_hash),
      KEY idx_change_dismissals_source (source_page_id)
    )`,
  },
  // M4: one proposed edit of a copy per confirmed change. `stale` = the copy page changed since the proposal;
  // `needs_manual` = the text cannot be replaced safely in the storage format; `failed` = the edit could not be made.
  {
    name: 'v023_create_proposals',
    statement: `CREATE TABLE IF NOT EXISTS proposals (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      change_id VARCHAR(36) NOT NULL,
      copy_id VARCHAR(36) NOT NULL,
      fact_id VARCHAR(36) NOT NULL,
      source_page_id VARCHAR(32) NOT NULL,
      page_id VARCHAR(32) NOT NULL,
      page_version_at_proposal INT NULL,
      old_sentence TEXT NULL,
      new_sentence TEXT NULL,
      old_value VARCHAR(512) NULL,
      new_value VARCHAR(512) NULL,
      status VARCHAR(16) NOT NULL,
      method VARCHAR(8) NULL,
      applied_version INT NULL,
      applied_by VARCHAR(128) NULL,
      error_code VARCHAR(32) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_proposals_page_status (page_id, status),
      KEY idx_proposals_source (source_page_id),
      KEY idx_proposals_change (change_id)
    )`,
  },
  { name: 'v024_proposals_change_copy_unique', statement: 'CREATE UNIQUE INDEX IF NOT EXISTS uq_proposals_change_copy ON proposals (change_id, copy_id)' },
  // M4: when stale proposals of a (change, copy page) were last queued again; at most one job per 2 minutes plus one
  // delayed follow-up (`delay_queued`), so a page edited often does not flood the queue.
  // Rewritten in place: the first version named the column `delayed`, a reserved word TiDB fails to parse, so it never
  // applied anywhere (the runner records a name only after its DDL succeeds) and production never shipped it.
  {
    name: 'v025_create_propose_requeues',
    statement: `CREATE TABLE IF NOT EXISTS propose_requeues (
      change_id VARCHAR(36) NOT NULL,
      page_id VARCHAR(32) NOT NULL,
      source_page_id VARCHAR(32) NOT NULL,
      requeued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delay_queued TINYINT(1) NOT NULL DEFAULT 0,
      PRIMARY KEY (change_id, page_id),
      KEY idx_propose_requeues_source (source_page_id)
    )`,
  },
  // Last good Teamwork Graph answer per space (team ids and names, also "no teams"): fresh for 10 minutes, and used
  // for up to 24 hours when the graph fails. Errors are never stored.
  {
    name: 'v026_create_space_team_cache',
    statement: `CREATE TABLE IF NOT EXISTS space_team_cache (
      space_id VARCHAR(32) NOT NULL,
      teams_json JSON NOT NULL,
      fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (space_id)
    )`,
  },
  // M5: one Jira issue per copy-page owner per confirmed change. The row is the claim (`creating`) that keeps a
  // redelivered job from creating a second issue; `failed` / an old `creating` row may be claimed again.
  {
    name: 'v027_create_change_issues',
    statement: `CREATE TABLE IF NOT EXISTS change_issues (
      change_id VARCHAR(36) NOT NULL,
      owner_account_id VARCHAR(128) NOT NULL,
      source_page_id VARCHAR(32) NOT NULL,
      issue_id VARCHAR(32) NULL,
      issue_key VARCHAR(64) NULL,
      issue_url VARCHAR(512) NULL,
      assignee_set TINYINT(1) NOT NULL DEFAULT 0,
      page_count INT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (change_id, owner_account_id),
      KEY idx_change_issues_key (issue_key)
    )`,
  },
  // M5 hardening: the claim's token (complete/fail only by the job that holds the claim), the number of claims (no
  // more retries after 3 failed ones) and whether the closing comment was posted (not posted twice).
  { name: 'v028_change_issues_claim_token', statement: 'ALTER TABLE change_issues ADD COLUMN IF NOT EXISTS claim_token VARCHAR(36) NULL' },
  { name: 'v029_change_issues_attempts', statement: 'ALTER TABLE change_issues ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0' },
  { name: 'v030_change_issues_comment_sent', statement: 'ALTER TABLE change_issues ADD COLUMN IF NOT EXISTS comment_sent TINYINT(1) NOT NULL DEFAULT 0' },
  // M5 fix: when a full propose job of a confirmed change finished; Jira issues (and the heal for them) wait for it.
  { name: 'v031_changes_proposed_at', statement: 'ALTER TABLE changes ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMP NULL' },
];

/** Name of the newest migration; the byline reports it so admins can confirm the schema is current. */
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? '';
