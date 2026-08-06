/**
 * House style, enforced in code.
 *
 * Models reach for em-dashes constantly, and agent-authored text lands in the
 * profile, the dashboard, ticket drafts and spoken briefings. Asking each agent
 * to avoid them in its prompt works most of the time, which is the problem -
 * "most of the time" means it shows up in the one draft nobody re-reads. So the
 * rule is applied mechanically to everything an agent produces.
 *
 * Applied to the raw response before JSON parsing: these characters only ever
 * appear inside string values, so substituting them cannot change the shape of
 * the document.
 */

/** Em, en, figure and horizontal-bar dashes, plus the minus sign. */
const DASHES = /[‒–—―−]/g;

export function stripEmDashes(text: string): string {
  return text.replace(DASHES, "-");
}

/**
 * Everything an agent wrote, normalised. Kept as one named function so the next
 * house rule has an obvious home rather than being scattered.
 */
export function normaliseAgentText(text: string): string {
  return stripEmDashes(text);
}
