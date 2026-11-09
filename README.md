# Ripple — Teamwork Graph prototype

Minimal Forge app (UI Kit, `confluence:contentBylineItem` "Ripple owners") that de-risks the core Ripple
dependency: reading page owners from the Teamwork Graph (Preview) curated query `confluencePageOwners`.

- `src/resolvers/index.js` — resolver `getPageOwners`: calls `api.asUser().requestTeamworkGraph()` with
  `query ripple_pageOwners { confluencePageOwners(id: <page ARI>, first: 25) … }` and the
  `X-Query-Context: ari:cloud:platform::site/<cloudId>` header (same pattern as Tripwire, which works on this
  site). When the graph returns no owners it falls back to Confluence REST v2 `GET /wiki/api/v2/pages/{id}`
  (`ownerId`/`authorId`, as user). Logs one JSON line per call (`{"app":"ripple","op":…,"pageId","owners","rawCount","dataPresent","errors"}`).
- `src/frontend/index.jsx` — shows owners, a source label (`via Teamwork Graph` / `via Confluence REST (fallback)`),
  the raw TWG edge count, whether `data` was present, and any GraphQL error.
- Scopes: `read:graph:page:confluence`, `read:graph:space:confluence`, `read:graph:team:atlassian`,
  `read:graph:user:atlassian`, `read:page:confluence`.

## Deploy / install / test

Use Node 22/24 (`export PATH=~/.nvm/versions/node/v24.22.2/bin:$PATH`; that also brings Forge CLI 15.0.0).

```sh
npm install
forge lint
forge deploy -e development --non-interactive
forge install --site one-atlas-vyyd.atlassian.net --product confluence -e development --non-interactive
# after scope changes:
forge install --upgrade --site one-atlas-vyyd.atlassian.net --product confluence -e development --non-interactive
```

Test: open any Confluence page on one-atlas-vyyd, click **Ripple owners** in the byline, accept the
"Allow access" consent if asked, then read the panel and `forge logs -e development --since 15m`.

## Test results (2026-11-08)

- Deploy + install with all four `read:graph:*` scopes: **OK**, no org-admin approval was asked
  (installation `bf9735d2-…`, development, one-atlas-vyyd Confluence).
- The byline call itself (`asUser()` from a resolver) is **not verified yet**: no automated browser was
  available, so no user has opened the module; `forge logs` has no `confluencePageOwners` line from the resolver.
- Attempted workaround: a temporary dev-only webtrigger calling `api.asUser(<accountId>).requestTeamworkGraph()`
  (with `read:app-user-token`) for the 5 most recently modified pages. Every call failed with
  `Forge platform failed to process runtime HTTP request - 401 - NO_IMPERSONATION_SCOPES_DEFINED`
  (the user has not granted consent to the app yet). `asApp()` has no `requestTeamworkGraph` in `@forge/api` 8.x,
  so TWG cannot be read from webtriggers, scheduled triggers or queue consumers without a prior user consent.
  The probe was removed again (app version 5).
- First real click (page 7110657, via byline): TWG returned `rawCount 1`, `data` present, but error
  `The field at path '/confluencePageOwners/edges[0]/node' was declared as a non null type, but ... returned a null value`,
  so 0 owners and the REST fallback answered (owner accountId, no name).
- v5.1.0 (diagnostic): one click now runs three selections and logs each (`variant` A/B/C, `rawCount`,
  `nullNodes`, `types`, `errors`): A = Tripwire's `... on AtlassianUser { id accountId }`, B = `__typename ... on
  AtlassianUser { id }`, C = A + `name`. The best variant feeds the owner list; names missing from the graph are
  rendered by UI Kit `<User accountId>` (no extra scope). Result of the next click: pending.
- Real click on v5.1.0: `confluencePageOwners` returned null nodes in every variant.
- v5.2.0: the same click also runs `confluencePageContributors` (Tripwire's exact selection; no edge metadata,
  so "main contributor" = first edge) and `atlassianTeamsBySpace(spaceAri: ari:cloud:confluence:<cloudId>:space/<spaceId>)`
  (space id from the byline context, else REST v2 page `spaceId`). Logs: `op` `confluencePageContributors` /
  `atlassianTeamsBySpace` with `count`, `nullNodes`, `types`, `errors`. Result of the next click: pending.
- Implication for Ripple: TWG reads need a user-initiated surface (resolver) or user consent before
  background/impersonated reads; plan the "owners" lookup around that.
