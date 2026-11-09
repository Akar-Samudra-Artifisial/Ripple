import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { SaveSettingsResult, SettingsView } from '../../src/core/views';
import { call } from './bridge';
import { Alert, LoadingRows, errorOf } from './components';
import { mount } from './mount';

/** Jira project keys: start with a letter, then uppercase letters, digits or underscores (Jira default 2–10). */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,9}$/;

const SAVE_ERROR: Record<NonNullable<SaveSettingsResult['errorCode']>, string> = {
  invalid_key: 'That is not a valid Jira project key. Use uppercase letters and digits, starting with a letter (for example OPS).',
  not_allowed: 'Only Jira administrators can change this setting.',
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

mount(<Settings />);
