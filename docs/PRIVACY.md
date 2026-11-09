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
- **Create and delete spaces** (`write:confluence-space`): used **only** by the admin's "Load demo data" and
  "Remove demo data" buttons. Each space a load creates carries "Created by Ripple demo data" and a random demo id of
  this installation (stored in `demo`) in its description; a load never adopts a marked space with another or no demo
  id. "Remove demo data" deletes only spaces recorded as created with the same id AND carrying this installation's demo
  id (spaces from versions before the demo id: recorded id and marker), with their pages, and then Ripple's data for
  the demo source; other spaces with the same keys are left alone. Each space is looked up again right before its
  DELETE. Remaining risk: Confluence deletes a space by key, so a space deleted and re-created under the same key in
  the moment between that lookup and the DELETE (which needs Confluence space admin rights) would be deleted.
  "Load demo data" creates
  the Nimbus Labs demo spaces (`NLHR`, `NLONB`, `NLFIN`, `NLSALES`, `NLHELP`) and their pages as that admin (Jira
  administrators only). Ripple never creates, changes or deletes spaces otherwise. Its progress (space and page ids and links,
  and the optional owner account ids the admin entered, at most 6) is stored in the `settings` table under `demo`;
  logs carry only ids, counts and error codes, never an account id. Copy pages are handed to those owners by saving
  the page once more with a new owner; if that fails, the admin stays the owner.
- **User display names** (`read:user:confluence`): show the page owner's name next to their update (as the viewing
  user, so profile visibility settings apply). Names are not stored.
- **Jira** (`read:jira-work`, `write:jira-work`): one update task per page owner per change, and the approval panel.
  Only when an admin set a Jira project in Ripple settings. Ripple creates the task as the app in that project and
  sends: the owner's account id (assignee and an @mention), the changed facts as "label: old value → new value" (only
  when the source page has no read restriction; otherwise only "An official fact changed; open the pages below to
  review the proposed update"), the owner's pages (title and link only when the page has no read restriction,
  otherwise "Page <id>" linked by id as `/wiki/pages/viewpage.action?pageId=<id>`, without the title), the team name
  of the spaces of those unrestricted pages from Teamwork Graph, the deadline (due date) and the labels `ripple`,
  `ripple-update` and `ripple-c<8 characters of the change id>-<8 characters of a SHA-256 hash of the owner's account
  id>` (used to find the task again instead of creating a second one; it does not contain the account id). The
  source page's title is used in the task summary only when it has no read restriction. When every page is done,
  Ripple adds a short comment and moves the task to Done. Ripple stores the task's id, key and link per change and
  owner; the Jira admin check reads only the viewer's own global ADMINISTER permission, as that user
  (`mypermissions`), when the settings page is opened or saved.
  **Limitation:** "no read restriction" means neither the page nor its ancestors restrict viewing. Ripple cannot read
  space permissions with its scopes, so a page in a space that only some groups may view counts as unrestricted and
  its title, link and the facts of a source in such a space can appear in the Jira task. Pick a Jira project whose
  audience matches the Confluence spaces Ripple watches (people who can see the task can also see those spaces), or
  leave the Jira project empty.
  A page whose parent is a folder (or another non-page) also counts as restricted: reading folders needs
  `read:folder:confluence`, which Ripple does not request. Each check has a time budget; when it runs out the page
  counts as restricted too.
- **Teamwork Graph, read-only** (`read:graph:*`): page owners/contributors and the team linked to a space, used to
  route update tasks. Nothing is written to the graph.
