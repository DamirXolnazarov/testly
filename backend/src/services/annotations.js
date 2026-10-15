/**
 * annotations.js
 * Comments a teacher pins to words in a student's essay. Each one covers
 * text[start, end) of the essay as submitted — the essay can't change after
 * the test, so character offsets stay put — and carries a category (one of
 * the four IELTS criteria, or "good" for praise), a comment, and optionally
 * a correction.
 *
 * Shape: { id, start, end, quote, category, comment, correction }
 */

const CATEGORIES = ["grammar", "lexical", "coherence", "task", "good"];
const MAX_PER_TASK = 200;

/**
 * Cleans annotations from the marking screen against the essay they belong
 * to: drops any that don't fit the text, recomputes each quote from the
 * text itself, sorts them, and drops any that overlap an earlier one.
 */
function sanitizeAnnotations(list, text) {
  if (!Array.isArray(list)) return [];
  const essay = String(text || "");
  const clean = [];
  for (const a of list) {
    const start = Number(a?.start);
    const end = Number(a?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > essay.length || start >= end) continue;
    const category = CATEGORIES.includes(a.category) ? a.category : "grammar";
    clean.push({
      id: typeof a.id === "string" && a.id ? a.id.slice(0, 40) : `a${start}-${end}`,
      start,
      end,
      quote: essay.slice(start, end),
      category,
      comment: typeof a.comment === "string" ? a.comment.trim().slice(0, 1000) : "",
      correction: typeof a.correction === "string" ? a.correction.trim().slice(0, 300) : "",
    });
  }
  clean.sort((x, y) => x.start - y.start);
  const kept = [];
  for (const a of clean) {
    if (kept.length && a.start < kept[kept.length - 1].end) continue;
    kept.push(a);
    if (kept.length >= MAX_PER_TASK) break;
  }
  return kept;
}

/**
 * Finds where each quoted phrase sits in the essay. Models report the words,
 * not reliable offsets, so each quote is searched for — preferring the first
 * occurrence after the previous one found, since issues come back in reading
 * order — and anything that can't be found, or would overlap one already
 * placed, is dropped rather than pinned to the wrong words.
 *
 * @param {{ quote: string }[]} issues
 * @param {string} text
 * @param {{ start: number, end: number }[]} [taken] - ranges already annotated
 * @returns {Array} each issue with start / end added
 */
function anchorQuotes(issues, text, taken = []) {
  const essay = String(text || "");
  const placed = taken.map((r) => ({ start: r.start, end: r.end }));
  const overlaps = (s, e) => placed.some((r) => s < r.end && r.start < e);
  const out = [];
  let cursor = 0;
  for (const issue of issues) {
    const quote = String(issue?.quote || "").trim();
    if (!quote) continue;
    // Whole-word matches only, so "is" isn't found inside "This".
    const hits = [];
    for (let at = essay.indexOf(quote); at !== -1; at = essay.indexOf(quote, at + 1)) {
      const before = essay[at - 1];
      const after = essay[at + quote.length];
      if ((/\w/.test(quote[0]) && before && /\w/.test(before)) || (/\w/.test(quote[quote.length - 1]) && after && /\w/.test(after))) continue;
      hits.push(at);
    }
    const start = hits.find((h) => h >= cursor && !overlaps(h, h + quote.length)) ?? hits.find((h) => !overlaps(h, h + quote.length));
    if (start === undefined) continue;
    const end = start + quote.length;
    placed.push({ start, end });
    cursor = end;
    out.push({ ...issue, quote, start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

module.exports = { CATEGORIES, sanitizeAnnotations, anchorQuotes };
