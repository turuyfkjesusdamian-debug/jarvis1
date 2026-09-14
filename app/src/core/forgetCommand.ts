/**
 * Detects an explicit "olvida X" / "olvídate de X" instruction, distinct
 * from "no olvides X" (which means the opposite — remember — and is
 * already handled by memory/shouldPersist.ts). Kept as a standalone regex
 * checked before intent classification, so a forget command never
 * accidentally gets persisted as a new fact by shouldPersist just because
 * its text happens to mention a project/person/preference keyword.
 */
const FORGET_REGEX = /\bolv[ií]da(?:te)?\b(?:\s+de)?(?:\s+que)?\s+(.+)/i;

/** Returns the text to forget, or undefined if the utterance isn't a forget command. */
export function parseForgetCommand(utterance: string): string | undefined {
  const match = FORGET_REGEX.exec(utterance.trim());
  const text = match?.[1]?.trim().replace(/[.!?¡¿]+$/, "").trim();
  return text && text.length > 0 ? text : undefined;
}

// Not `\b` after the accented vowel: JS's \b only recognizes ASCII word
// characters, so "í" followed by end-of-string doesn't count as a boundary
// and "sí" alone would silently fail to match. A lookahead for
// whitespace/punctuation/end sidesteps that, and also correctly rejects
// "sin" (without) despite starting with "si".
const AFFIRMATIVE_REGEX = /^\s*s[ií](?=[\s,.!]|$)/i;

/** Same "ambiguous or unclear counts as no" rule as the Android confirm-then-act flow. */
export function isAffirmative(utterance: string): boolean {
  return AFFIRMATIVE_REGEX.test(utterance.trim());
}
