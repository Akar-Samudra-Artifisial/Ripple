# Ripple Privacy Policy

Draft (M0). Ripple is an Atlassian Forge app for Confluence (required) and Jira (optional), built for Atlassian
Codegeist 2026.

## Where the app runs

Ripple runs entirely on Atlassian's Forge platform and makes no network calls outside Atlassian product APIs and
Forge services. Fact extraction and matching use Forge LLM, a Claude model hosted by Atlassian inside Forge.

## Data the app stores

Forge SQL inside your site's Forge storage: references to pages and spaces (ids), short quotes of facts, settings,
and an audit trail of who confirmed, approved or rejected what and when.

## Permissions and what they are used for

- **Confluence pages, labels, spaces, search** (`read:confluence-content.*`, `read:page:confluence`,
  `read:label:confluence`, `read:space:confluence`, `search:confluence`): find source-of-truth facts and their copies.
- **Write pages** (`write:page:confluence`): apply an edit only after its page owner approves it, as that user.
- **Create spaces** (`write:confluence-space`): used **only** by the admin's "Load demo data" button, which creates
  the Nimbus Labs demo spaces (HR, ONB, FIN, SALES, HELP). Ripple never creates or changes spaces otherwise.
- **User display names** (`read:user:confluence`): show the page owner's name next to their update (as the viewing
  user, so profile visibility settings apply). Names are not stored.
- **Jira** (`read:jira-work`, `write:jira-work`): one update task per page owner per change, and the approval panel.
- **Teamwork Graph, read-only** (`read:graph:*`): page owners/contributors and the team linked to a space, used to
  route update tasks. Nothing is written to the graph.
