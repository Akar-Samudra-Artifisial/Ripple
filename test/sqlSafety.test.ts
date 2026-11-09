import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { statement: string; params: unknown[] }[] = [];
let failWith: unknown;
/** Affected rows per statement (undefined: 0 for every write). */
let affected: ((statement: string) => number) | undefined;

vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('@forge/sql', () => ({
  migrationRunner: {},
  sql: {
    prepare: (statement: string) => ({
      bindParams: (...params: unknown[]) => ({
        execute: async () => {
          calls.push({ statement, params });
          if (failWith) throw failWith;
          const rows = [{ page_id: '9600001', fact_id: 'f-1', chunk_text: 'x' }];
          return { rows: affected === undefined ? rows : Object.assign(rows, { affectedRows: affected(statement) }) };
        },
      }),
    }),
  },
}));

import { sqlChangeIssueRepo } from '../src/adapters/changeIssueRepo';
import { sqlChangeRepo } from '../src/adapters/changeRepo';
import { MIGRATIONS } from '../src/core/migrations';
import { sqlProposalRepo } from '../src/adapters/proposalRepo';
import { sqlRepo } from '../src/adapters/repo';
import { sqlScanRepo } from '../src/adapters/scanRepo';
import { sqlSpaceTeamCache } from '../src/adapters/spaceTeams';
import { sqlErrorInfo, sqlInt, sqlOp } from '../src/core/schema';

beforeEach(() => {
  calls.length = 0;
  failWith = undefined;
  affected = undefined;
});

describe('M4 proposal writes', () => {
  const FC = { factId: 'f-1', oldValue: '$60', oldUnit: null, newValue: '$75', newUnit: null, newQuote: 'q', version: 4, versionAt: null };

  it('revertFactChange rejects the open proposals of that change as reverted', async () => {
    affected = () => 1;
    const r = await sqlChangeRepo.revertFactChange('9600001', FC, ['c-1'], 'ch-1');
    expect(r).toMatchObject({ reverted: true, proposals: 1 });
    const reject = calls.find((c) => c.statement.startsWith('UPDATE proposals'));
    expect(reject?.statement).toBe("UPDATE proposals SET status = 'rejected', error_code = 'reverted' WHERE change_id = ? AND fact_id = ? AND status IN ('proposed', 'stale', 'needs_manual')");
    expect(reject?.params).toEqual(['ch-1', 'f-1']);
  });

  it('supersedeOlder only touches open proposals of other changes of these facts', async () => {
    affected = () => 2;
    expect(await sqlProposalRepo.supersedeOlder('9600001', 'ch-2', ['f-1', 'f-2'])).toBe(2);
    expect(calls[0]?.statement).toContain("status IN ('proposed', 'stale', 'needs_manual') AND fact_id IN (?, ?)");
    expect(calls[0]?.params).toEqual(['9600001', 'ch-2', 'f-1', 'f-2']);
  });

  it('claimRequeue: first claim now, then delayed once within 2 minutes, then skip', async () => {
    affected = () => 1;
    expect(await sqlProposalRepo.claimRequeue('ch-1', '9700001', '9600001')).toBe('now');
    affected = (s) => (s.includes('delay_queued = 1') ? 1 : 0);
    expect(await sqlProposalRepo.claimRequeue('ch-1', '9700001', '9600001')).toBe('delayed');
    expect(calls.some((c) => c.statement.includes('INTERVAL 120 SECOND'))).toBe(true);
    affected = () => 0;
    expect(await sqlProposalRepo.claimRequeue('ch-1', '9700001', '9600001')).toBe('skip');
  });
});

describe('Forge SQL LIMIT (TiDB rejects a bound LIMIT with ER_WRONG_ARGUMENTS)', () => {
  it('pendingPages inlines the LIMIT instead of binding it', async () => {
    await sqlScanRepo.pendingPages('scan-1', 5);
    const first = calls[0];
    expect(first?.statement).toMatch(/LIMIT 5$/);
    expect(first?.params).toEqual(['scan-1']);
  });

  it('no statement in src binds LIMIT/OFFSET', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
      });
    const offenders = files(join(__dirname, '../src')).filter((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .some((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line) && /\b(?:LIMIT|OFFSET)\s+\?/i.test(line)),
    );
    expect(offenders).toEqual([]);
  });

  it('sqlInt truncates, clamps and rejects non-numbers', () => {
    expect(sqlInt(5.9, 1, 100)).toBe(5);
    expect(sqlInt(0, 1, 100)).toBe(1);
    expect(sqlInt(1000, 1, 100)).toBe(100);
    expect(() => sqlInt(Number.NaN, 1, 100)).toThrow('sqlInt');
  });
});

/**
 * MySQL 8 / TiDB reserved words that read like column or table names. An unquoted one fails the whole DDL with
 * ER_PARSE_ERROR (v025 `delayed` stuck the dev schema at 24/25 steps).
 */
const RESERVED = new Set(
  (
    'accessible add all alter analyze and as asc before between bigint binary blob both by call cascade case change char character check collate column ' +
    'condition constraint continue convert create cross cube cume_dist current_date current_time current_timestamp current_user cursor database databases ' +
    'day_hour day_minute day_second dec decimal declare default delayed delete dense_rank desc describe distinct distinctrow div double drop dual each else ' +
    'elseif empty enclosed escaped except exists exit explain false fetch first_value float for force foreign from fulltext function generated get grant ' +
    'group grouping groups having high_priority if ignore in index infile inner inout insert int integer intersect interval into is iterate join json_table ' +
    'key keys kill lag last_value lateral lead leading leave left like limit linear lines load localtime localtimestamp lock long loop low_priority match ' +
    'maxvalue mod natural not nth_value ntile null of on optimize option optionally or order out outer outfile over partition percent_rank precision primary ' +
    'procedure purge range rank read reads real recursive references regexp release rename repeat replace require restrict return revoke right rlike row ' +
    'row_number rows schema schemas select separator set show signal smallint spatial sql sqlexception sqlstate sqlwarning ssl starting stored straight_join ' +
    'system table terminated then tinyint to trailing trigger true union unique unlock unsigned until update usage use using utc_date utc_time utc_timestamp ' +
    'values varbinary varchar varying virtual when where while window with write xor year_month zerofill'
  ).split(' '),
);

/** Table, column and index names a migration statement defines (unquoted identifiers only; we never backquote). */
function definedIdentifiers(statement: string): string[] {
  const s = statement.replace(/\s+/g, ' ');
  const names: string[] = [];
  const table = /CREATE TABLE IF NOT EXISTS (\w+) \((.*)\)\s*$/i.exec(s);
  if (table) {
    names.push(table[1]!);
    // Top-level definitions only: split on commas outside parentheses (VARCHAR(36), KEY idx (a, b)).
    let depth = 0;
    let part = '';
    const parts: string[] = [];
    for (const ch of table[2]!) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(part);
        part = '';
      } else part += ch;
    }
    parts.push(part);
    for (const p of parts) {
      const words = p.trim().split(' ');
      const first = (words[0] ?? '').toUpperCase();
      if (['PRIMARY', 'CONSTRAINT', 'FOREIGN', 'CHECK'].includes(first)) continue;
      if (['KEY', 'INDEX', 'UNIQUE'].includes(first)) {
        const name = words.find((w, i) => i > 0 && !/^(KEY|INDEX)$/i.test(w));
        if (name && !name.startsWith('(')) names.push(name);
        continue;
      }
      names.push(words[0] ?? '');
    }
  }
  const column = /ADD COLUMN IF NOT EXISTS (\w+)/i.exec(s);
  if (column) names.push(column[1]!);
  const index = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)/i.exec(s);
  if (index) names.push(index[1]!, index[2]!);
  return names.filter(Boolean);
}

describe('migration identifiers (TiDB rejects unquoted reserved words with ER_PARSE_ERROR)', () => {
  it('no migration names a table, column or index with a reserved word', () => {
    const offenders = MIGRATIONS.flatMap((m) => definedIdentifiers(m.statement).filter((n) => RESERVED.has(n.toLowerCase())).map((n) => `${m.name}: ${n}`));
    expect(offenders).toEqual([]);
  });

  it('catches the v025 mistake (`delayed` column) and finds the columns of every CREATE TABLE', () => {
    const bad = 'CREATE TABLE IF NOT EXISTS t (id VARCHAR(36) NOT NULL, delayed TINYINT(1) NOT NULL DEFAULT 0, PRIMARY KEY (id, x), KEY idx_t (id))';
    expect(definedIdentifiers(bad)).toEqual(['t', 'id', 'delayed', 'idx_t']);
    expect(definedIdentifiers(bad).filter((n) => RESERVED.has(n))).toEqual(['delayed']);
    for (const m of MIGRATIONS.filter((x) => /^CREATE TABLE/i.test(x.statement.trim()))) expect(definedIdentifiers(m.statement).length, m.name).toBeGreaterThan(2);
  });
});

describe('change_issues (M5)', () => {
  it('claims with INSERT IGNORE, then takes over only failed (< 3 attempts) or stale claims with a new token; bound values, no LIMIT', async () => {
    affected = (s) => (s.startsWith('INSERT IGNORE') ? 0 : 1);
    const token = await sqlChangeIssueRepo.claim('ch-1', 'acc-1', '9600001', 2);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.statement).toBe(
      "INSERT IGNORE INTO change_issues (change_id, owner_account_id, source_page_id, page_count, status, claim_token, attempts) VALUES (?, ?, ?, ?, 'creating', ?, 1)",
    );
    expect(calls[0]?.params).toEqual(['ch-1', 'acc-1', '9600001', 2, token]);
    expect(calls[1]?.statement).toContain('claim_token = ?, attempts = attempts + 1');
    expect(calls[1]?.statement).toContain("((status = 'failed' AND attempts < 3) OR (status = 'creating' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 300 SECOND)))");
    expect(calls[1]?.params).toEqual([token, 2, 'ch-1', 'acc-1']);
    affected = () => 0;
    expect(await sqlChangeIssueRepo.claim('ch-1', 'acc-1', '9600001', 2)).toBeNull();
    expect(await sqlChangeIssueRepo.complete('ch-1', 'acc-1', 'tok-1', { id: '10', key: 'OPS-1', url: 'https://x/browse/OPS-1', assigneeSet: false })).toBe(false);
    await sqlChangeIssueRepo.fail('ch-1', 'acc-1', 'tok-1');
    await sqlChangeIssueRepo.markCommentSent('ch-1', 'acc-1');
    await sqlChangeIssueRepo.setStatus('ch-1', 'acc-1', 'created', 'closed');
    await sqlChangeIssueRepo.saveJiraSettings({ projectKey: 'OPS' });
    await sqlChangeIssueRepo.byIssueKey('OPS-1');
    expect(calls.some((c) => /LIMIT/i.test(c.statement))).toBe(false);
    // complete / fail only by the holder of the claim token.
    const complete = calls.find((c) => c.statement.startsWith("UPDATE change_issues SET status = 'created'"));
    expect(complete?.statement).toMatch(/AND status = 'creating' AND claim_token = \?$/);
    expect(complete?.params).toEqual(['10', 'OPS-1', 'https://x/browse/OPS-1', 0, 'ch-1', 'acc-1', 'tok-1']);
    const fail = calls.find((c) => c.statement.startsWith("UPDATE change_issues SET status = 'failed'"));
    expect(fail?.statement).toMatch(/AND status = 'creating' AND claim_token = \?$/);
    expect(fail?.params).toEqual(['ch-1', 'acc-1', 'tok-1']);
    expect(calls.find((c) => c.statement.includes('comment_sent = 1'))?.statement).toContain("status = 'closed'");
    expect(calls.find((c) => c.statement.startsWith('INSERT INTO settings'))?.params).toEqual(['jira', '{"projectKey":"OPS"}']);
  });
});

describe('space_team_cache', () => {
  it('reads and upserts one row per space with bound values only (age computed in SQL, no LIMIT)', async () => {
    await sqlSpaceTeamCache.get('7');
    await sqlSpaceTeamCache.put('7', [{ id: 't1', name: "O'Brien Team" }]);
    expect(calls.map((c) => c.statement)).toEqual([
      'SELECT teams_json, TIMESTAMPDIFF(SECOND, fetched_at, CURRENT_TIMESTAMP) AS age_seconds FROM space_team_cache WHERE space_id = ?',
      'INSERT INTO space_team_cache (space_id, teams_json, fetched_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE teams_json = VALUES(teams_json), fetched_at = CURRENT_TIMESTAMP',
    ]);
    expect(calls[0]?.params).toEqual(['7']);
    expect(calls[1]?.params).toEqual(['7', JSON.stringify([{ id: 't1', name: "O'Brien Team" }])]);
    expect(calls.some((c) => /LIMIT/i.test(c.statement))).toBe(false);
  });
});

describe('page_events stays bounded', () => {
  it('claimPageEvent drops events older than 30 days before inserting; unmarkSource removes the page rows', async () => {
    await sqlChangeRepo.claimPageEvent('9600001', 4);
    expect(calls[0]?.statement).toBe('DELETE FROM page_events WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)');
    expect(calls[0]?.params).toEqual([]);
    expect(calls[1]).toEqual({ statement: 'INSERT IGNORE INTO page_events (page_id, version) VALUES (?, ?)', params: ['9600001', 4] });
    calls.length = 0;
    await sqlRepo.unmarkSource('9600001');
    const deletes = calls.map((c) => c.statement);
    expect(deletes).toContain('DELETE FROM page_events WHERE page_id = ?');
    expect(deletes).toContain('DELETE FROM change_dismissals WHERE source_page_id = ?');
    expect(deletes).toContain('DELETE FROM proposals WHERE source_page_id = ?');
    expect(deletes).toContain('DELETE FROM propose_requeues WHERE source_page_id = ?');
    expect(deletes.indexOf('DELETE FROM proposals WHERE source_page_id = ?')).toBeLessThan(deletes.indexOf('DELETE FROM changes WHERE source_page_id = ?'));
    expect(deletes.at(-1)).toBe('DELETE FROM sources WHERE page_id = ?');
  });
});

describe('safe SQL error details', () => {
  it('labels statements by verb and table only', () => {
    expect(sqlOp("SELECT DISTINCT page_id FROM scan_hits WHERE scan_id = ? AND status = 'pending'")).toBe('SELECT scan_hits');
    expect(sqlOp('INSERT INTO copies (id) VALUES (?)')).toBe('INSERT copies');
    expect(sqlOp('UPDATE scan_jobs SET state = ?')).toBe('UPDATE scan_jobs');
  });

  it('tags a failed statement with its operation and reads the masked MySQL error', async () => {
    failWith = Object.assign(new Error('Unknown SQL execution error'), {
      code: 'SQL_EXECUTION_ERROR',
      context: { debug: { code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000', sqlMessage: "Duplicate entry 'secret page text' for key 'uq'" } },
    });
    const err = await sqlScanRepo.pendingPages('scan-1', 5).catch((e: unknown) => e);
    expect(sqlErrorInfo(err)).toEqual({ op: 'SELECT scan_hits', code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000', sqlMessage: "Duplicate entry '?' for key '?'" });
    expect(sqlErrorInfo(new Error('plain'))).toBeUndefined();
  });
});
