import type { ProposalState } from '../../src/core/views';

/** Short, blameless status labels shared by the copy-page panel and the Rollout tab. */
export const PROPOSAL_STATUS_LABEL: Record<ProposalState, string> = {
  proposed: 'Waiting for approval',
  approved: 'Applying',
  applied: 'Updated',
  rejected: 'Declined',
  stale: 'Refreshing',
  needs_manual: 'Needs manual edit',
  failed: 'Failed',
};

/** Why Ripple could not apply a suggestion, per backend error code (`src/core/proposals.ts` PROPOSAL_ERROR_CODES). */
export function proposalProblem(status: ProposalState, code: string | null): string {
  switch (code) {
    case 'forbidden':
      return "You don't have permission to edit this page.";
    case 'not_found':
      return 'The page could not be found. It may have been moved or deleted.';
    case 'conflict':
    case 'version_changed':
      return 'The page changed while Ripple was saving. Try again in a moment.';
    case 'page_not_readable':
      return 'Ripple could not read this page. Try again in a moment.';
    case 'crosses_markup':
      return 'The value sits inside formatting, a link or a table cell that Ripple does not rewrite.';
    case 'quote_not_found':
      return 'The sentence is no longer on the page in the same words.';
    case 'sentence_ambiguous':
      return 'The same sentence appears more than once on the page.';
    case 'value_ambiguous':
    case 'value_not_found':
      return 'Ripple could not tell which value in the sentence to change.';
    case 'validation_failed':
    case 'llm_failed':
      return 'Ripple could not write a safe new sentence.';
    default:
      return status === 'needs_manual' ? 'Ripple could not edit this sentence safely.' : 'Something went wrong. Try again in a moment.';
  }
}
