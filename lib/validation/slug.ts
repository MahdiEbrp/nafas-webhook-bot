/**
 * Shared kebab-case slug pattern used by service/category/group schemas.
 *
 * The literal `-` separator means the repetition groups are unambiguous, so
 * matching is linear and there is no catastrophic-backtracking risk. The
 * upstream heuristic still flags nested repetition, hence the suppression.
 */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
