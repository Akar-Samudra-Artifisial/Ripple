# Ripple

Ripple keeps your official facts true everywhere they're repeated. Mark a Confluence page as the source of truth;
Ripple extracts its facts, finds every page that restates them, and when a fact changes it sends each page owner
one Jira task with ready-made edits to approve. Built on Forge (Confluence, Jira, Forge SQL, Forge LLM, Teamwork
Graph, Rovo).

Status: **M0** — foundation only. The byline shows "Ripple is ready", the database setup progress and the space's
owning team via Teamwork Graph; every other module is declared and answers "not implemented".

## Permissions

See `docs/PRIVACY.md`. `write:confluence-space` is used only by the "Load demo data" button (creates the demo
spaces HR/ONB/FIN/SALES/HELP); no other code path creates or changes spaces.

## Layout

- `src/index.ts` — function handlers referenced by `manifest.yml`
- `src/surfaces/` — resolvers (`ui.ts`), triggers and queue consumers (`background.ts`), Rovo actions (`actions.ts`)
- `src/adapters/` — Forge SQL (`sql.ts`), Teamwork Graph + Confluence REST v2 page (`teamworkGraph.ts`)
- `src/core/` — append-only migrations, migration pacing (`schema.ts`), shared view types
- `src/llm/` — Forge LLM tool-call wrapper
- `ui/src/` — Custom UI views, built by `scripts/build-ui.mjs` into `static/<view>/build`
- `test/` — vitest

## Develop

Node 24 (`export PATH="$HOME/.nvm/versions/node/<v24>/bin:$PATH"`).

```sh
npm install
npm run build   # typecheck + Custom UI bundles
npm test
npm run lint    # forge lint
forge deploy -e development --non-interactive
forge install --upgrade   # after scope/module changes
```

Schema changes: append a migration to `src/core/migrations.ts` (never edit an applied one). DDL only runs in the
`schema-migrate` consumer, queued on install/upgrade, paced for the Forge SQL DDL rate limit.
