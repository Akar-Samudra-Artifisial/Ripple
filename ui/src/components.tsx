import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface AlertProps {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  tone?: 'danger' | 'warning';
}

/** Inline alert (announced via role="alert") with an optional retry action. */
export function Alert({ message, onRetry, retryLabel = 'Try again', retryDisabled, tone = 'danger' }: AlertProps) {
  return (
    <div className={`alert alert--${tone}`} role="alert">
      <p className="alert__text">{message}</p>
      {onRetry ? (
        <button type="button" className="button" disabled={retryDisabled} onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Pulsing placeholder rows shown until the first reply arrives (never an empty state before data). */
export function LoadingRows({ label }: { label: string }) {
  return (
    <div className="facts-loading" aria-busy="true">
      <p className="muted" role="status">
        {label}
      </p>
      <div className="skeleton" aria-hidden="true" />
      <div className="skeleton" aria-hidden="true" />
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
}

interface TabsProps<T extends string> {
  idPrefix: string;
  label: string;
  tabs: readonly TabItem<T>[];
  selected: T;
  onSelect: (id: T) => void;
}

/** WAI-ARIA tabs: roving tabindex, Left/Right/Home/End move and activate. Panels use `${idPrefix}-panel-${id}`. */
export function Tabs<T extends string>({ idPrefix, label, tabs, selected, onSelect }: TabsProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === selected);
    const next =
      e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    const tab = tabs[next];
    if (!tab) return;
    e.preventDefault();
    onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            if (el) refs.current.set(t.id, el);
            else refs.current.delete(t.id);
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          aria-selected={selected === t.id}
          tabIndex={selected === t.id ? 0 : -1}
          className="tabs__tab"
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idPrefix, id, children }: { idPrefix: string; id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className="tabs__panel">
      {children}
    </div>
  );
}
