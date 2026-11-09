import { router } from '@forge/bridge';
import type { ApprovalView } from '../../src/core/views';
import { useRemote } from './bridge';
import { Alert, LoadingRows } from './components';
import { httpsUrl } from './links';
import { mount } from './mount';

type Page = NonNullable<ApprovalView['task']>['pages'][number];

const formatDay = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function PageRow({ page }: { page: Page }) {
  const title = page.title ?? `Page ${page.pageId}`;
  const done = page.open === 0;
  const url = httpsUrl(page.url);
  return (
    <li className="rollout__row">
      {url ? (
        <a
          className="copy__link rollout__page"
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            void router.open(url).catch(() => undefined);
          }}
        >
          {title}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="rollout__page">{title}</span>
      )}
      {page.open > 0 ? <span className="badge badge--proposal-proposed">{page.open} waiting</span> : null}
      {page.applied > 0 ? <span className="badge badge--proposal-applied">{page.applied} updated</span> : null}
      {done && page.applied === 0 ? <span className="badge badge--proposal-rejected">Nothing waiting</span> : null}
    </li>
  );
}

/**
 * Jira issue panel of a Ripple update task (read-only): the owner's copy pages with their suggestion counts. Approval
 * happens on the Confluence page. States: loading → error | not a Ripple task | list.
 */
function Approval() {
  const { data, error, loading } = useRemote<ApprovalView>('getApproval');

  if (loading) {
    return (
      <main className="shell">
        <LoadingRows label="Loading pages…" />
      </main>
    );
  }
  if (error || !data) {
    return (
      <main className="shell">
        <Alert message={`Could not load the Ripple pages: ${error ?? 'no reply'}`} />
      </main>
    );
  }
  const { task } = data;
  if (!task) {
    return (
      <main className="shell">
        <p className="muted">This issue was not created by Ripple, so there are no pages to show.</p>
      </main>
    );
  }

  const due = formatDay(task.deadline);
  return (
    <main className="shell approval">
      <p className="muted source__meta">
        {task.closed ? 'Every page in this task is done.' : 'Pages that state an old value from a source of truth.'}
        {due && !task.closed ? ` Due ${due}.` : ''}
      </p>
      {task.pages.length > 0 ? (
        <ul className="rollout__list" aria-label="Pages in this task">
          {task.pages.map((p) => (
            <PageRow key={p.pageId} page={p} />
          ))}
        </ul>
      ) : (
        <p className="empty">No pages to show.</p>
      )}
      {task.morePages > 0 ? (
        <p className="muted source__meta">
          And {task.morePages} more {task.morePages === 1 ? 'page' : 'pages'}.
        </p>
      ) : null}
      <p className="muted source__meta">Approve each suggestion on the Confluence page, in the Ripple byline. This panel is read-only.</p>
    </main>
  );
}

mount(<Approval />);
