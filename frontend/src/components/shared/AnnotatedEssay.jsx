import React, { useRef } from "react";

/**
 * AnnotatedEssay — an essay with a teacher's annotations highlighted in it.
 * Used by the marking screen (components/admin/WritingMarking.jsx), where
 * selecting words starts a new annotation, and by the student's feedback
 * page (pages/feedback/[token].jsx), which is read-only.
 *
 * An annotation covers text[start, end) — offsets into the essay as
 * submitted (see backend/src/services/annotations.js). They must not
 * overlap; both the marking screen and the backend make sure of that.
 * The number on each highlight is drawn with CSS (::after), so it isn't
 * part of the text and selection offsets stay true to the essay.
 */

export const CATEGORIES = {
  grammar: { label: "Grammar", color: "#C8372D", soft: "#FDE8E6" },
  lexical: { label: "Vocabulary", color: "#B45309", soft: "#FEF0C7" },
  coherence: { label: "Coherence", color: "#1D5FD1", soft: "#E1EBFD" },
  task: { label: "Task response", color: "#5B50E6", soft: "#EEECFD" },
  good: { label: "Well done", color: "#17803D", soft: "#DDF5E4" },
};
export const CATEGORY_KEYS = Object.keys(CATEGORIES);

/** Annotations in reading order, numbered from 1. */
export function numberAnnotations(list) {
  return [...(list || [])].sort((a, b) => a.start - b.start).map((a, i) => ({ ...a, n: i + 1 }));
}

/**
 * @param {string} text
 * @param {Array} annotations - numbered (numberAnnotations), each optionally `suggested`
 * @param {string} [activeId]
 * @param {(id: string) => void} [onPick] - a highlight was clicked
 * @param {(range: { start, end, rect: DOMRect }) => void} [onSelect] - words were selected (marking screen only)
 */
export default function AnnotatedEssay({ text, annotations, activeId, onPick, onSelect, className = "" }) {
  const ref = useRef(null);
  const essay = String(text || "");

  const segments = [];
  let at = 0;
  for (const a of annotations || []) {
    if (a.start < at || a.end > essay.length) continue;
    if (a.start > at) segments.push({ text: essay.slice(at, a.start) });
    segments.push({ text: essay.slice(a.start, a.end), a });
    at = a.end;
  }
  if (at < essay.length) segments.push({ text: essay.slice(at) });

  const offsetOf = (node, offset) => {
    const range = document.createRange();
    range.setStart(ref.current, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  };

  const handleMouseUp = () => {
    if (!onSelect || !ref.current) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!ref.current.contains(range.startContainer) || !ref.current.contains(range.endContainer)) return;
    let start = offsetOf(range.startContainer, range.startOffset);
    let end = offsetOf(range.endContainer, range.endOffset);
    if (start > end) [start, end] = [end, start];
    // Snap to whole words and drop surrounding spaces.
    while (start > 0 && /\w/.test(essay[start - 1]) && /\w/.test(essay[start])) start--;
    while (end < essay.length && /\w/.test(essay[end]) && /\w/.test(essay[end - 1])) end++;
    while (start < end && /\s/.test(essay[start])) start++;
    while (end > start && /\s/.test(essay[end - 1])) end--;
    if (end <= start) return;
    onSelect({ start, end, rect: range.getBoundingClientRect() });
  };

  return (
    <>
    {/* Outside the text container: its CSS would otherwise count towards selection offsets. */}
    <style dangerouslySetInnerHTML={{ __html: CSS }} />
    <div ref={ref} className={`ae-text ${onSelect ? "selectable" : ""} ${className}`} onMouseUp={handleMouseUp} onTouchEnd={() => setTimeout(handleMouseUp, 0)}>
      {segments.map((s, i) => {
        if (!s.a) return <React.Fragment key={i}>{s.text}</React.Fragment>;
        const cat = CATEGORIES[s.a.category] || CATEGORIES.grammar;
        return (
          <mark
            key={s.a.id}
            id={`ae-mark-${s.a.id}`}
            data-n={s.a.n}
            className={`ae-mark ${s.a.suggested ? "suggested" : ""} ${activeId === s.a.id ? "active" : ""} ${s.a.correction && s.a.category !== "good" ? "corrected" : ""}`}
            style={{ "--ae-c": cat.color, "--ae-soft": cat.soft }}
            onClick={(e) => { e.stopPropagation(); onPick && onPick(s.a.id); }}
          >
            {s.text}
          </mark>
        );
      })}
    </div>
    </>
  );
}

const CSS = `
.ae-text { white-space:pre-wrap; word-wrap:break-word; }
.ae-text.selectable { cursor:text; }
.ae-mark { background:var(--ae-soft); color:inherit; border-bottom:2px solid var(--ae-c); border-radius:3px 3px 0 0; padding:0 1px; cursor:pointer; transition:background-color .15s ease, box-shadow .15s ease; }
.ae-mark.corrected { text-decoration:line-through; text-decoration-color:color-mix(in srgb, var(--ae-c) 70%, transparent); text-decoration-thickness:1.5px; }
.ae-mark::after { content:attr(data-n); display:inline-block; margin-left:2px; padding:0 4px; min-width:15px; border-radius:8px; background:var(--ae-c); color:#fff; font-size:9.5px; font-weight:700; line-height:14px; text-align:center; vertical-align:super; text-decoration:none; }
.ae-mark.suggested { background:transparent; border-bottom-style:dashed; }
.ae-mark.suggested::after { background:#fff; color:var(--ae-c); box-shadow:inset 0 0 0 1px var(--ae-c); }
.ae-mark.active { box-shadow:0 0 0 2px var(--ae-c); }
.ae-mark:hover { filter:brightness(.97); }
@media print { .ae-mark { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
`;
