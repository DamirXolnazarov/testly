import React from "react";

/**
 * QuestionTypes.jsx — the two renderers stubbed out in the schema but not yet
 * built: "matching" and "map". Same visual language as IELTSCDReplica.jsx
 * (reuses its .gap-box / .qbadge / .radio-row classes, so no extra CSS import
 * needed as long as this renders inside a page that already loaded that CSS).
 *
 * Usage inside QuestionBlock-style code:
 *   if (q.type === "matching") return <MatchingQuestion q={q} value={value} onChange={onChange} />
 *   if (q.type === "map")      return <MapQuestion q={q} value={value} onChange={onChange} />
 */

// ---- Matching: student matches a prompt to one of a shared option bank ----
// q = { id, prompt, options: ["A paragraph mentions...", ...], optionLetters: ["A","B","C"] }
export function MatchingQuestion({ q, value, onChange }) {
  const letters = q.optionLetters || q.options.map((_, i) => String.fromCharCode(65 + i));
  return (
    <div className="matching-q">
      <p className="matching-prompt">{q.prompt}</p>
      <select
        className="matching-select"
        value={value || ""}
        onChange={(e) => onChange(q.id, e.target.value)}
      >
        <option value="" disabled>Choose a letter…</option>
        {letters.map((letter, i) => (
          <option key={letter} value={letter}>
            {letter} — {q.options[i]}
          </option>
        ))}
      </select>
    </div>
  );
}

// Option bank shown once above a group of matching questions (real IELTS style:
// the list of options is shown once, then each question just picks a letter).
export function MatchingOptionBank({ options, optionLetters }) {
  const letters = optionLetters || options.map((_, i) => String.fromCharCode(65 + i));
  return (
    <div className="matching-bank">
      {options.map((opt, i) => (
        <div className="matching-bank-row" key={letters[i]}>
          <span className="matching-letter">{letters[i]}</span>
          <span>{opt}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Map / diagram labeling: click a numbered pin, type the label ----
// q = { id, imageUrl, points: [{ id, x, y, n }] }  x/y are % (0-100) of image
export function MapQuestion({ q, values, onChange }) {
  const [active, setActive] = React.useState(null);
  return (
    <div className="map-q">
      <div className="map-wrap">
        <img src={q.imageUrl} alt="Map" className="map-img" />
        {q.points.map((pt) => (
          <button
            key={pt.id}
            className={`map-pin ${active === pt.id ? "active" : ""} ${values[pt.id] ? "filled" : ""}`}
            style={{ left: `${pt.x}%`, top: `${pt.y}%` }}
            onClick={() => setActive(pt.id)}
            title={`Question ${pt.n}`}
          >
            {pt.n}
          </button>
        ))}
      </div>
      <div className="map-inputs">
        {q.points.map((pt) => (
          <div className={`map-input-row ${active === pt.id ? "active" : ""}`} key={pt.id}>
            <span className="qbadge">{pt.n}</span>
            <input
              className="gap-box"
              placeholder="Label"
              value={values[pt.id] || ""}
              onFocus={() => setActive(pt.id)}
              onChange={(e) => onChange(pt.id, e.target.value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export const QUESTION_TYPE_CSS = `
.matching-q { margin-bottom:16px; font-size:14px; }
.matching-prompt { margin-bottom:8px; }
.matching-select { width:100%; padding:8px 10px; border:1px solid #999; border-radius:3px; font-size:13px; }
.matching-bank { border:1px solid #eee; border-radius:4px; padding:12px 14px; margin-bottom:18px; background:#fafafa; }
.matching-bank-row { display:flex; gap:10px; font-size:13.5px; padding:4px 0; }
.matching-letter { font-weight:700; min-width:18px; }

.map-q { display:flex; gap:20px; flex-wrap:wrap; }
.map-wrap { position:relative; flex:1; min-width:260px; border:1px solid #ddd; }
.map-img { width:100%; display:block; }
.map-pin { position:absolute; transform:translate(-50%,-50%); width:24px; height:24px; border-radius:50%; border:2px solid #1a1a1a; background:#fff; font-size:11px; font-weight:700; cursor:pointer; transition:background-color .15s ease, transform .15s ease; }
.map-pin:hover { transform:translate(-50%,-50%) scale(1.1); }
.map-pin.active { background:#1a1a1a; color:#fff; }
.map-pin.filled { border-color:#2f8a4a; }
.map-inputs { flex:1; min-width:200px; display:flex; flex-direction:column; gap:10px; }
.map-input-row { display:flex; align-items:center; gap:10px; padding:6px; border-radius:4px; transition:background-color .15s ease; }
.map-input-row.active { background:#f2f2f2; }
`;