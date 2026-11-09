import { router } from '@forge/bridge';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { DemoOwnersCheck, DemoRemoveResult, DemoStatus, SaveSettingsResult, SettingsView } from '../../src/core/views';
import { call } from './bridge';
import { Alert, LoadingRows, errorOf } from './components';
import { httpsUrl } from './links';
import { mount } from './mount';

/** The admin check needs the user's consent for Ripple in Jira (asUser), which has not been given yet. */
const NEEDS_AUTH = "Couldn't check your Jira permissions. Open Ripple in Jira once to grant access, then try again.";

/** Jira project keys: start with a letter, then uppercase letters, digits or underscores (Jira default 2–10). */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,9}$/;

const SAVE_ERROR: Record<NonNullable<SaveSettingsResult['errorCode']>, string> = {
  invalid_key: 'That is not a valid Jira project key. Use uppercase letters and digits, starting with a letter (for example OPS).',
  not_allowed: 'Only Jira administrators can change this setting.',
  admin_check_failed: "Couldn't check your Jira permissions. Try again in a moment.",
  admin_needs_auth: NEEDS_AUTH,
  project_not_found: 'No Jira project with this key was found, or Ripple cannot see it.',
  jira_unavailable: 'Ripple is not installed in Jira on this site. Install it in Jira, then try again.',
  jira_error: 'Jira did not respond as expected. Try again in a moment.',
};

function keyProblem(key: string): string | null {
  if (key === '') return null;
  return KEY_PATTERN.test(key) ? null : 'Use 2–10 uppercase letters, digits or underscores, starting with a letter.';
}

/**
 * Ripple settings (Confluence global settings): the Jira project for update tasks. States: loading rows → error +
 * retry | form (read-only for non-administrators) with saved / error results announced politely.
 */
function Settings() {
  const [view, setView] = useState<SettingsView>();
  const [loadError, setLoadError] = useState<string>();
  const [key, setKey] = useState('');
  const [hint, setHint] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string }>();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError(undefined);
    try {
      const v = await call<SettingsView>('getSettings');
      setView(v);
      setKey(v.jiraProjectKey ?? '');
    } catch (e) {
      setLoadError(errorOf(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!view?.canEdit || saving) return;
    const trimmed = key.trim();
    const problem = keyProblem(trimmed);
    setHint(problem ?? undefined);
    setResult(undefined);
    if (problem) {
      input.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const r = await call<SaveSettingsResult>('saveSettings', { jiraProjectKey: trimmed === '' ? null : trimmed });
      if (r.ok) {
        setView({ ...view, jiraProjectKey: trimmed === '' ? null : trimmed });
        setResult({ tone: 'ok', text: trimmed === '' ? 'Saved. Ripple will not create Jira tasks.' : `Saved. New changes create Jira tasks in ${trimmed}.` });
      } else {
        setResult({ tone: 'error', text: r.errorCode ? SAVE_ERROR[r.errorCode] : 'The setting was not saved. Try again in a moment.' });
      }
    } catch (err) {
      setResult({ tone: 'error', text: `The setting was not saved. ${errorOf(err)}` });
    } finally {
      setSaving(false);
    }
  };

  if (!view) {
    return (
      <main className="shell settings">
        <h1 className="shell__title">Ripple settings</h1>
        {loadError ? <Alert message={`Could not load the settings: ${loadError}`} onRetry={() => void load()} /> : <LoadingRows label="Loading settings…" />}
      </main>
    );
  }

  const saved = view.jiraProjectKey ?? '';
  const unchanged = key.trim() === saved;
  const describedBy = `${id}-help${hint ? ` ${id}-error` : ''}`;

  return (
    <main className="shell settings">
      <h1 className="shell__title">Ripple settings</h1>
      <p className="muted settings__intro">
        When a source of truth changes, Ripple can create one Jira task per page owner whose copies are out of date. The task links to the pages; owners approve
        each suggestion on the Confluence page.
      </p>
      <form className="settings__form" onSubmit={(e) => void save(e)} noValidate>
        <label className="field" htmlFor={`${id}-key`}>
          <span className="field__label">Jira project key</span>
          <input
            id={`${id}-key`}
            ref={input}
            className="field__input settings__input"
            value={key}
            readOnly={!view.canEdit}
            maxLength={10}
            autoComplete="off"
            spellCheck={false}
            placeholder={view.canEdit ? 'e.g. OPS' : undefined}
            aria-describedby={describedBy}
            aria-invalid={hint ? true : undefined}
            onChange={(e) => {
              setKey(e.target.value.toUpperCase());
              setHint(undefined);
              setResult(undefined);
            }}
          />
        </label>
        <p id={`${id}-help`} className="muted source__meta">
          {view.canEdit ? 'Uppercase letters and digits, starting with a letter. Leave empty to turn Jira tasks off.' : saved ? `Jira tasks are created in ${saved}.` : 'No Jira project is set, so Ripple does not create Jira tasks.'}
        </p>
        {hint ? (
          <p id={`${id}-error`} className="field__error">
            {hint}
          </p>
        ) : null}
        {view.canEdit ? (
          <div className="actions">
            <button type="submit" className="button button--primary" disabled={saving || unchanged} aria-busy={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : view.adminCheck === 'needs_auth' ? (
          <Alert message={`${NEEDS_AUTH} The setting is read-only for now.`} onRetry={() => void load()} />
        ) : view.adminCheck === 'check_failed' ? (
          <Alert message="Couldn't check your Jira permissions, so the setting is read-only for now. Try again in a moment." onRetry={() => void load()} />
        ) : (
          <p className="muted">Only Jira administrators can change this setting.</p>
        )}
      </form>
      <div aria-live="polite" className="settings__result">
        {result ? <p className={result.tone === 'ok' ? 'ok' : 'field__error'}>{result.text}</p> : null}
      </div>
    </main>
  );
}

const DEMO_ERROR: Record<string, string> = {
  not_allowed: 'Only Jira administrators can load demo data.',
  admin_check_failed: "Couldn't check your Jira permissions. Try again in a moment.",
  admin_needs_auth: NEEDS_AUTH,
  invalid_owner_ids: 'Enter up to 6 Atlassian account IDs, separated by commas or new lines.',
  owner_invalid: 'Every owner must be an active Atlassian account you can see. Check the account IDs and try again.',
  owner_check_failed: "Couldn't look up the owners. Try again in a moment.",
  owner_change_failed: 'Demo data loaded, but some pages could not be given to the other owners. You own those pages for now.',
  space_key_taken:
    'A space with one of the demo keys (NLHR, NLONB, NLFIN, NLSALES, NLHELP) already exists and was not created by Ripple, so Ripple left it alone. Rename or delete that space to load the demo data.',
  foreign_space:
    'A space with one of the demo keys (NLHR, NLONB, NLFIN, NLSALES, NLHELP) is marked as Ripple demo data but was not created by this Ripple installation, so Ripple left it alone. Rename or delete that space to load the demo data.',
  space_being_deleted: 'Confluence is still deleting the earlier demo spaces. Wait a minute, then load the demo data again.',
  demo_busy: 'Demo data is being loaded or removed right now. Try again in a minute.',
};

const DEMO_KEYS = 'NLHR, NLONB, NLFIN, NLSALES and NLHELP';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function demoErrorText(code: string): string {
  if (DEMO_ERROR[code]) return DEMO_ERROR[code];
  if (code.startsWith('space_create_http_403')) return 'You need permission to create spaces in Confluence to load demo data.';
  if (code === 'space_delete_http_403') return 'You need permission to delete these spaces in Confluence to remove the demo data.';
  if (code.startsWith('space_delete_') || (code.startsWith('space_find_') && code !== 'space_find_http_403')) return `Removing stopped (${code}). Press Remove demo data again to continue.`;
  return `Loading stopped (${code}). Press the button again to continue where it stopped.`;
}

function ExternalLink({ url, children }: { url: string; children: string }) {
  return (
    <a
      className="copy__link"
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        void router.open(url).catch(() => undefined);
      }}
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * M6 "Load demo data": creates the Nimbus Labs spaces and pages as the administrator, calling `loadDemoData` again
 * while it reports `loading` (each call works within a time budget). Pressing again after a stop resumes.
 */
function DemoData() {
  const [status, setStatus] = useState<DemoStatus>();
  const [loadError, setLoadError] = useState<string>();
  const [owners, setOwners] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  /** Owners looked up and waiting for the admin's confirmation. */
  const [confirm, setConfirm] = useState<{ ids: string[]; check: DemoOwnersCheck }>();
  /** "Remove demo data" waits for an explicit confirmation. */
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removed, setRemoved] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const id = useId();

  const refresh = useCallback(async () => {
    setLoadError(undefined);
    try {
      setStatus(await call<DemoStatus>('getDemoStatus'));
    } catch (e) {
      setLoadError(errorOf(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Calls `loadDemoData` until it is no longer `loading` (each call works within a time budget). */
  const run = async (payload: { ownerAccountIds?: string[]; retryOwners?: boolean }) => {
    setProblem(undefined);
    setConfirm(undefined);
    setBusy(true);
    try {
      let s = await call<DemoStatus>('loadDemoData', payload);
      setStatus(s);
      // Later calls keep the owners already saved (no `ownerAccountIds`): only the retry flag carries over.
      const next: { retryOwners?: boolean } = payload.retryOwners ? { retryOwners: true } : {};
      for (let i = 0; s.state === 'loading' && i < 10; i++) {
        const before = s.step;
        s = await call<DemoStatus>('loadDemoData', next);
        setStatus(s);
        // Another load holds the lock: wait a moment instead of asking again at once.
        if (s.state === 'loading' && s.step === before) await pause(2000);
      }
    } catch (e) {
      setProblem(`Loading stopped. ${errorOf(e)} Press the button again to continue.`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setConfirmRemove(false);
    setProblem(undefined);
    setRemoved(undefined);
    setBusy(true);
    setRemoving(true);
    try {
      const r = await call<DemoRemoveResult>('removeDemoData');
      setStatus(r.status);
      if (r.errorCode) {
        setProblem(demoErrorText(r.errorCode));
      } else {
        const kept = r.keptSpaces.length ? ` Left alone because Ripple did not create them: ${r.keptSpaces.join(', ')}.` : '';
        setRemoved(`Demo data removed. Confluence finishes deleting the spaces in the background, so wait a minute before loading it again.${kept}`);
      }
    } catch (e) {
      setProblem(`Removing stopped. ${errorOf(e)} Press Remove demo data again to continue.`);
    } finally {
      setRemoving(false);
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy) return;
    setRemoved(undefined);
    const ids = owners
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter((x) => x !== '');
    if (ids.length > 6) {
      setProblem(DEMO_ERROR.invalid_owner_ids);
      return;
    }
    // Empty input: keep the owners chosen before (or the admin owns every page).
    if (ids.length === 0) return run({});
    setProblem(undefined);
    setBusy(true);
    try {
      const check = await call<DemoOwnersCheck>('checkDemoOwners', { ownerAccountIds: ids });
      if (check.errorCode) {
        const which = check.invalidAccountIds.length ? ` Not usable: ${check.invalidAccountIds.join(', ')}.` : '';
        setProblem(`${demoErrorText(check.errorCode)}${which}`);
      } else {
        setConfirm({ ids, check });
      }
    } catch (e) {
      setProblem(`Couldn't look up the owners. ${errorOf(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return loadError ? <Alert message={`Could not load the demo data status: ${loadError}`} onRetry={() => void refresh()} /> : <LoadingRows label="Loading demo data status…" />;
  }
  const source = httpsUrl(status.sourcePageUrl);
  const error = problem ?? (status.errorCode ? demoErrorText(status.errorCode) : undefined);

  return (
    <section className="settings__form" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Demo data</h2>
      <p className="muted">
        Creates five Nimbus Labs spaces with an official Travel Policy and pages that repeat its facts, some of them out of date. Open the Travel Policy and mark it as a
        source of truth to try Ripple.
      </p>
      {status.canEdit && status.state !== 'done' ? (
        <>
          <label className="field" htmlFor={`${id}-owners`}>
            <span className="field__label">Owner account IDs (optional, up to 6)</span>
            <input
              id={`${id}-owners`}
              className="field__input"
              value={owners}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${id}-owners-help`}
              onChange={(e) => {
                setOwners(e.target.value);
                setProblem(undefined);
                setConfirm(undefined);
              }}
            />
          </label>
          <p id={`${id}-owners-help`} className="muted source__meta">
            Copy pages are shared among these accounts. Leave empty to keep the owners chosen before (or own every page yourself).
          </p>
          {confirm ? (
            <div className="settings__confirm" role="group" aria-labelledby={`${id}-confirm`}>
              <p id={`${id}-confirm`}>
                These people will become owners of {confirm.check.pages} demo pages:
              </p>
              <ul>
                {confirm.check.owners.map((o) => (
                  <li key={o.accountId}>{o.name}</li>
                ))}
              </ul>
              <div className="actions">
                <button type="button" className="button button--primary" disabled={busy} onClick={() => void run({ ownerAccountIds: confirm.ids })}>
                  Load demo data
                </button>
                <button type="button" className="button" disabled={busy} onClick={() => setConfirm(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button type="button" className="button button--primary" disabled={busy} aria-busy={busy} onClick={() => void start()}>
                {busy ? 'Loading…' : status.state === 'idle' ? 'Load demo data' : 'Continue loading'}
              </button>
            </div>
          )}
        </>
      ) : status.canEdit && status.errorCode === 'owner_change_failed' ? (
        <div className="actions">
          <button type="button" className="button" disabled={busy} aria-busy={busy} onClick={() => void run({ retryOwners: true })}>
            {busy ? 'Retrying…' : 'Retry owners'}
          </button>
        </div>
      ) : !status.canEdit ? (
        <p className="muted">Only Jira administrators can load demo data.</p>
      ) : null}
      {status.canEdit && (status.state !== 'idle' || status.spaces.length > 0) ? (
        confirmRemove ? (
          <div className="settings__confirm" role="alertdialog" aria-labelledby={`${id}-remove`}>
            <p id={`${id}-remove`}>
              Remove demo data? Ripple deletes the spaces {DEMO_KEYS} with all their pages, and its own data for the demo Travel Policy. This cannot be undone from
              Ripple. Spaces with these keys that Ripple did not create are left alone.
            </p>
            <div className="actions">
              <button type="button" className="button button--danger" disabled={busy} onClick={() => void remove()}>
                Delete demo spaces
              </button>
              <button type="button" className="button" disabled={busy} onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button type="button" className="button" disabled={busy} aria-busy={busy} onClick={() => setConfirmRemove(true)}>
              {removing ? 'Removing…' : 'Remove demo data'}
            </button>
          </div>
        )
      ) : null}
      <div aria-live="polite" className="settings__result">
        {removing ? <p className="muted">Removing demo data…</p> : null}
        {(status.state === 'loading' || busy) && !removing ? (
          <p className="muted">
            Created {status.step} of {status.total} spaces and pages…
          </p>
        ) : null}
        {status.state === 'done' ? (
          <p className="ok">
            Demo data is ready.{' '}
            {source ? <ExternalLink url={source}>Open the Travel Policy</ExternalLink> : null}
          </p>
        ) : null}
        {removed ? <p className="ok">{removed}</p> : null}
        {error ? <p className="field__error">{error}</p> : null}
      </div>
      {status.spaces.length > 0 ? (
        <ul className="settings__spaces">
          {status.spaces.map((s) => {
            const url = httpsUrl(s.url);
            return <li key={s.key}>{url ? <ExternalLink url={url}>{s.name}</ExternalLink> : s.name}</li>;
          })}
        </ul>
      ) : null}
    </section>
  );
}

function SettingsPage() {
  return (
    <>
      <Settings />
      <div className="shell settings">
        <DemoData />
      </div>
    </>
  );
}

mount(<SettingsPage />);
