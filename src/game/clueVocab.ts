/**
 * Keep only words that really occur in a clue, and use that clue as the example so the card's
 * blank-out always works. Multi-word expressions match as a phrase; single words also match inflections.
 */
export function anchorToClues<T extends { word: string; example: string }>(items: T[], clues: string[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const word = item.word.trim();
    if (!word) continue;
    // Each word is matched by its stem so inflections ("borrows the fear" for "borrow the fear") still count.
    const stem = (w: string) => w.replace(/(ing|ed|es|s)$/i, "").slice(0, Math.max(3, w.length - 3));
    const pattern = word.split(/\s+/).map((w) => stem(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\S*\\s+");
    const re = new RegExp(`\\b${pattern}`, "i");
    const clue = clues.find((c) => re.test(c));
    if (!clue) continue;
    out.push({ ...item, example: clue });
  }
  return out;
}
