import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { statement: string; params: unknown[] }[] = [];
let failWith: unknown;

vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('@forge/sql', () => ({
  migrationRunner: {},
  sql: {
    prepare: (statement: string) => ({
      bindParams: (...params: unknown[]) => ({
        execute: async () => {
          calls.push({ statement, params });
          if (failWith) throw failWith;
          return { rows: [{ page_id: '9600001', fact_id: 'f-1', chunk_text: 'x' }] };
        },
      }),
    }),
  },
}));

import { sqlChangeRepo } from '../src/adapters/changeRepo';
import { sqlRepo } from '../src/adapters/repo';
import { sqlScanRepo } from '../src/adapters/scanRepo';
import { sqlErrorInfo, sqlInt, sqlOp } from '../src/core/schema';

beforeEach(() => {
  calls.length = 0;
  failWith = undefined;
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
