# Ripple — agent rules

Forge app (Confluence + Jira) for Codegeist 2026. Product spec: `../Ripple — Product Requirements Document (Codegeist 2026).md`.
Structure and patterns follow Tripwire (`../../Tripwire/tripwire/`); copy from it, never change it.

## Stack

- TypeScript (strict, `noUncheckedIndexedAccess`), Node 24 runtime (`nodejs24.x`), no `any`.
- Custom UI with React 19 + plain CSS using Atlassian design tokens (`ui/src`, bundled by esbuild). Not UI Kit.
- Forge SQL (MySQL/TiDB), Forge LLM (`@forge/llm`, model in `src/llm/index.ts`), queues (`@forge/events`),
  Teamwork Graph via `api.asUser().requestTeamworkGraph()` (resolvers only).

## Rules

- Verify after every change: `npm run build`, `npm test`, `npm run lint` (`forge lint`).
- Migrations are append-only in `src/core/migrations.ts`, every statement `IF NOT EXISTS`, one ADD per ALTER.
  DDL runs only in the `schema-migrate` consumer; everything else calls `ensureSchema()` (no DDL).
- SQL is always parameterised (`query`/`execute` in `src/adapters/sql.ts`).
- LLM calls only from queue consumers (900 s timeout), never from resolvers. Validate tool arguments; quotes must be
  found verbatim in the page text before use.
- Write to Confluence as the approving user (`asUser`). Check permissions server-side for every resolver.
- Logs: ids, counts and scrubbed errors (`scrubErrorText`) only; never page content, names or account ids.
- The manifest is final for the MVP: adding scopes or `sql`/`llm` modules is a major upgrade that needs a site
  admin to approve in production. Deploy only to `development` unless told otherwise.
- UI text in English. Keep CHANGELOG.md (Keep a Changelog, `[Unreleased]`) up to date.
