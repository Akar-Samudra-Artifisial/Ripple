/**
 * Forge queue concurrency keys (scoped to the installation, across all queues). An event that finds its key's slot
 * taken is postponed by Forge and retried with a growing delay (up to 15 minutes), so unrelated work must not share
 * a key: one key per source page for jobs that write its facts (extraction, diff), one per change for proposals.
 * The `ripple-` names replace the earlier per-page keys shared by all three job kinds, whose slot on the dev install
 * stayed taken (8.23.0: a propose job and the next diff of one source were never delivered).
 */
export const pageJobKey = (pageId: string): string => `ripple-page-${pageId}`;
export const proposeJobKey = (changeId: string): string => `ripple-propose-${changeId}`;
