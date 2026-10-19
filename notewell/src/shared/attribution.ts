/**
 * Decides which parts of the enhanced notes came from the user's own notes,
 * so the UI can show them in ink and AI additions in grey (the convention
 * Granola popularised). Pure token overlap, no model involved.
 */
export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[(.*?)\]\(.*?\)/g, "$1") // markdown links → text
    .replace(/[*_`#>~[\]]/g, " ")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 || /\d/.test(t));
}

/**
 * Returns a predicate that is true when a block of enhanced output carries
 * (most of) one of the user's lines.
 */
export function makeUserTextMatcher(userNotes: string, threshold = 0.75): (block: string) => boolean {
  const lines = userNotes
    .split(/\r?\n/)
    .map((line) => new Set(normalizeTokens(line)))
    .filter((tokens) => tokens.size >= 2);
  return (block) => {
    if (!lines.length) return false;
    const tokens = new Set(normalizeTokens(block));
    if (!tokens.size) return false;
    return lines.some((line) => {
      let shared = 0;
      for (const t of line) if (tokens.has(t)) shared++;
      return shared / line.size >= threshold;
    });
  };
}
