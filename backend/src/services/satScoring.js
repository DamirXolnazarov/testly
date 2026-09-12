/**
 * services/satScoring.js
 *
 * Digital SAT is module-adaptive: each scored section (Reading & Writing,
 * Math) is split into a fixed Module 1 that every student sees, and a
 * Module 2 that comes in two variants ("easy" / "hard"). Which variant a
 * student gets is decided by their Module 1 performance, and that choice
 * changes how their raw score converts to a final 200-800 scaled score —
 * getting everything right on the easy Module 2 caps out well below 800,
 * because it doesn't demonstrate the student could handle harder material.
 *
 * ============================================================================
 * IMPORTANT — READ BEFORE TRUSTING THESE NUMBERS FOR ANYTHING HIGH-STAKES
 * ============================================================================
 * College Board's real routing thresholds and scoring-equating tables are
 * proprietary and have never been published. Nobody outside College Board
 * has the actual curve. What follows is a deliberately reasonable,
 * monotonic APPROXIMATION built from publicly discussed patterns of how the
 * test behaves (routing around a ~60% Module 1 cutoff; an easy-path ceiling
 * well below 800; a hard-path ceiling at 800) — not a reverse-engineered or
 * leaked version of the real thing. Good enough to give students a
 * realistic-feeling mock score and to correctly demonstrate the adaptive
 * mechanic itself, but a real score report will differ. Say so anywhere
 * this number is shown to a student or admin — see the disclaimer text
 * exported below.
 * ============================================================================
 */

const SCALED_MIN = 200;
const SCALED_MAX = 800;

// Fraction of Module 1 questions that must be answered correctly to be
// routed to the harder Module 2. Configurable per section (routing.threshold
// in the exam JSON) so an admin can tune it; this is the default when a
// section doesn't set one.
const DEFAULT_ROUTING_THRESHOLD = 0.6;

/**
 * Decides which Module 2 variant a student is routed to, based on their
 * Module 1 raw score. Called server-side only (sessions.js) — the routing
 * decision must never be computed or trusted from the client, or a student
 * could simply request the easier Module 2 regardless of their actual
 * Module 1 performance.
 * @param {number} module1Correct - number of Module 1 questions answered correctly
 * @param {number} module1Total - total number of Module 1 questions
 * @param {number} [threshold] - fraction (0-1) required to route to "hard"; defaults to DEFAULT_ROUTING_THRESHOLD
 * @returns {"easy"|"hard"}
 */
function routeToModule2(module1Correct, module1Total, threshold) {
  if (!module1Total) return "easy"; // malformed section — fail toward the safer/simpler path
  const t = typeof threshold === "number" ? threshold : DEFAULT_ROUTING_THRESHOLD;
  return module1Correct / module1Total >= t ? "hard" : "easy";
}

/**
 * Converts a raw score (correct answers across Module 1 + whichever
 * Module 2 the student was routed to) into an approximate 200-800 scaled
 * score. Two different monotonic curves depending on the routed path —
 * this is the mechanism that makes the adaptive design matter for the
 * final score, not just the question difficulty during the test.
 *
 * Curve shape: smooth (quadratic ease-out) rather than linear, since real
 * score distributions aren't uniform — small raw-score differences near
 * the top of a path matter more than near the bottom. Deliberately simple
 * and auditable rather than trying to fake precision the real curve has
 * that we have no way of replicating.
 *
 * @param {number} rawCorrect - total correct across Module 1 + the routed Module 2
 * @param {number} rawTotal - total questions across Module 1 + that Module 2
 * @param {"easy"|"hard"} module2Path - which Module 2 variant was taken
 * @returns {number} an integer scaled score, 200-800
 */
function scaleScore(rawCorrect, rawTotal, module2Path) {
  if (!rawTotal) return SCALED_MIN;
  const fraction = Math.max(0, Math.min(1, rawCorrect / rawTotal));
  // Ease-out: rewards the last few correct answers more than the first few,
  // matching the general shape (not the exact values) of real SAT curves.
  const eased = 1 - Math.pow(1 - fraction, 1.6);

  // Hard path: spans the full 200-800 range.
  // Easy path: capped at 590 — a perfect score on the easier Module 2 still
  // reflects not having handled the harder material, so it can't reach the
  // same ceiling as the hard path. 590 is an illustrative, documented
  // choice (roughly "solid but not top-tier"), not a College Board figure.
  const ceiling = module2Path === "hard" ? SCALED_MAX : 590;
  const scaled = SCALED_MIN + eased * (ceiling - SCALED_MIN);

  // Scores are always reported as multiples of 10 on the real test.
  return Math.round(scaled / 10) * 10;
}

/** Shown next to any SAT scaled score in the UI — see the module-level
 * disclaimer above for why this exists and what it does and doesn't mean. */
const SCORE_APPROXIMATION_DISCLAIMER =
  "This is an approximate score based on a reasonable model of how the digital SAT's adaptive scoring works. " +
  "College Board's real scoring tables are not public, so this will not exactly match an official score report.";

module.exports = {
  routeToModule2,
  scaleScore,
  DEFAULT_ROUTING_THRESHOLD,
  SCALED_MIN,
  SCALED_MAX,
  SCORE_APPROXIMATION_DISCLAIMER,
};
