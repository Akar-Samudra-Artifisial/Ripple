import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text, Strong, Stack, Lozenge, User } from '@forge/react';
import { invoke } from '@forge/bridge';

// Labels shown next to the owner list, so the tester can tell where the data came from.
const SOURCE_LABEL = {
  twg: 'via Teamwork Graph',
  rest: 'via Confluence REST (fallback)',
  none: 'no source answered',
};

/** One diagnostic line per Teamwork Graph query variant (A/B/C, see the resolver). */
const VariantLine = ({ v }) => (
  <Text>
    <Strong>TWG {v.key}</Strong> [{v.selection}] owners {v.owners.length} · raw {v.rawCount} · null nodes {v.nullNodes} · data{' '}
    {String(v.dataPresent)}
    {v.types?.length ? ` · types ${v.types.join(',')}` : ''}
    {v.errors?.length ? ` · errors: ${v.errors.join(' | ')}` : ''}
  </Text>
);

/** Shared diagnostics suffix: raw edge count, null nodes, union types received and exact errors. */
const diag = (r) =>
  `raw ${r.rawCount} · null nodes ${r.nullNodes} · data ${String(r.dataPresent)}` +
  (r.types?.length ? ` · types ${r.types.join(',')}` : '') +
  (r.errors?.length ? ` · errors: ${r.errors.join(' | ')}` : '');

/** "Contributors via TWG": names resolved by UI Kit <User>; the first edge is labelled main contributor. */
const Contributors = ({ c }) => (
  <Stack space="space.050">
    <Text>
      <Strong>Contributors via TWG: {c.contributors.length}{c.hasNextPage ? '+' : ''}</Strong> · {diag(c)}
    </Text>
    {c.contributors.map((u, i) => (
      <Stack key={u.accountId} space="space.050">
        <User accountId={u.accountId} />
        {i === 0 ? <Text>main contributor (first edge)</Text> : null}
      </Stack>
    ))}
  </Stack>
);

/** "Space teams via TWG": team display names from atlassianTeamsBySpace. */
const SpaceTeams = ({ s }) => (
  <Stack space="space.050">
    <Text>
      <Strong>Space teams via TWG: {s.teams.length ? s.teams.map((t) => t.name).join(', ') : 'none'}</Strong> · space {s.spaceId || '?'} · {diag(s)}
    </Text>
  </Stack>
);

const App = () => {
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    invoke('getPageOwners').then(setResult).catch((err) => setFailure(String(err?.message ?? err)));
  }, []);

  if (failure) return <Text>Ripple failed: {failure}</Text>;
  if (!result) return <Text>Loading owners…</Text>;

  return (
    <Stack space="space.100">
      <Lozenge appearance={result.source === 'twg' ? 'success' : result.source === 'rest' ? 'moved' : 'removed'}>
        {(SOURCE_LABEL[result.source] ?? result.source) + (result.variant ? ` (variant ${result.variant})` : '')}
      </Lozenge>
      {result.owners.length === 0 ? <Text>No owners found.</Text> : null}
      {result.owners.map((o) => (
        // Names come from the graph when it returns them; otherwise the UI Kit <User> component resolves the
        // display name and avatar from the accountId without the app needing an extra user-read scope.
        <Stack key={o.accountId} space="space.050">
          {o.name ? <Text><Strong>{o.name}</Strong></Text> : <User accountId={o.accountId} />}
          <Text>
            {o.accountId}
            {o.role ? ` · ${o.role}` : ''}
          </Text>
        </Stack>
      ))}
      {(result.variants ?? []).map((v) => (
        <VariantLine key={v.key} v={v} />
      ))}
      {result.contributors ? <Contributors c={result.contributors} /> : null}
      {result.spaceTeams ? <SpaceTeams s={result.spaceTeams} /> : null}
      {result.errors?.length ? <Text>Errors: {result.errors.join(' | ')}</Text> : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
