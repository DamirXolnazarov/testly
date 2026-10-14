import React from "react";

/**
 * MathText.jsx — shows plain-text maths the way it is written on paper.
 *
 * Exam content stores maths as ordinary text that reads unambiguously —
 * x^2, sqrt(x + 1), (3x + 1)/(x - 2), x_1, <=, pi — which is what the AI
 * writers and the PDF importer produce and what a teacher can type in the
 * editor. This component is purely a display layer over that text: it draws
 * exponents raised, fractions stacked, roots under a bar and comparison
 * signs as real symbols. The stored text never changes, so answers are
 * still compared exactly as before.
 *
 * It is deliberately conservative about what counts as maths, because the
 * same sentence holds ordinary prose: "and/or", "km/h" and a date such as
 * 26/06/1974 are left alone. A slash only becomes a stacked fraction when
 * a side is a number or is in brackets.
 *
 * Use it only for maths content (the SAT Math section) — not for reading
 * passages, where a caret or an underscore is just a character.
 */

const S = {
  frac: { display: "inline-flex", flexDirection: "column", alignItems: "center", verticalAlign: "middle", margin: "0 0.18em", lineHeight: 1.15, fontSize: "0.92em" },
  num: { padding: "0 0.3em 0.06em", borderBottom: "1.5px solid currentColor" },
  den: { padding: "0.06em 0.3em 0" },
  root: { display: "inline-flex", alignItems: "stretch", verticalAlign: "middle", margin: "0 0.08em" },
  radical: { fontSize: "1.1em", lineHeight: 1 },
  radicand: { borderTop: "1.5px solid currentColor", padding: "0.08em 0.25em 0 0.15em", marginLeft: "-0.06em" },
  sup: { fontSize: "0.72em", verticalAlign: "super", lineHeight: 0 },
  sub: { fontSize: "0.72em", verticalAlign: "sub", lineHeight: 0 },
};

const isLetter = (c) => !!c && /[A-Za-z]/.test(c);

/** Index just past the bracket that closes the one at s[open], or -1. */
function closingBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth += 1;
    else if (s[i] === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Reads one thing a fraction or an exponent can attach to, starting at i:
 * sqrt(…), a bracketed group, a number with up to two trailing letters
 * (3x, 2ab), or a single-letter variable.
 */
function readOperand(s, i) {
  if (s.startsWith("sqrt(", i) && !isLetter(s[i - 1])) {
    const end = closingBracket(s, i + 4);
    if (end !== -1) return { kind: "sqrt", inner: s.slice(i + 5, end - 1), end };
  }
  if (s[i] === "(") {
    const end = closingBracket(s, i);
    if (end !== -1) return { kind: "group", inner: s.slice(i + 1, end - 1), end };
  }
  const number = s.slice(i).match(/^(\d+\.?\d*|\.\d+)[A-Za-z]{0,2}(?![A-Za-z])/);
  if (number && !isLetter(s[i - 1])) return { kind: "token", text: number[0], end: i + number[0].length };
  if (isLetter(s[i]) && !isLetter(s[i - 1]) && !isLetter(s[i + 1])) return { kind: "token", text: s[i], end: i + 1 };
  return null;
}

/** An exponent (^2, ^-1, ^(n + 1)) or a subscript (_1, _n) at position i, if there is one. */
function readScript(s, i) {
  if (s[i] !== "^" && s[i] !== "_") return null;
  if (s[i + 1] === "(") {
    const end = closingBracket(s, i + 1);
    if (end !== -1) return { type: s[i], inner: s.slice(i + 2, end - 1), end };
  }
  const plain = s.slice(i + 1).match(s[i] === "^" ? /^-?[A-Za-z0-9.]+/ : /^(\d+|[A-Za-z](?![A-Za-z]))/);
  return plain ? { type: s[i], inner: plain[0], end: i + 1 + plain[0].length } : null;
}

/** Prose-level symbols: comparison signs, pi, and a true minus sign. */
function symbols(text) {
  return text
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/!=/g, "≠")
    .replace(/\+-/g, "±")
    .replace(/(^|[^A-Za-z])pi(?![A-Za-z])/g, "$1π")
    .replace(/(^|[\s(=<>≤≥+*/,])-(?=[\dA-Za-z(.])/g, "$1−")
    .replace(/ - /g, " − ");
}

function parse(s, keyPrefix = "m") {
  const out = [];
  let text = "";
  let key = 0;
  const flush = () => {
    if (text) out.push(symbols(text));
    text = "";
  };
  const k = () => `${keyPrefix}${key++}`;

  /** Draws an operand, with any exponent or subscript that follows it. Returns [node, end]. */
  const draw = (op, bare) => {
    let node;
    if (op.kind === "sqrt") {
      node = <span key={k()} style={S.root}><span style={S.radical}>√</span><span style={S.radicand}>{parse(op.inner, k())}</span></span>;
    } else if (op.kind === "group") {
      // The brackets around a whole numerator or denominator are only
      // there to group it; the fraction bar does that job once drawn.
      node = bare ? <React.Fragment key={k()}>{parse(op.inner, k())}</React.Fragment> : <React.Fragment key={k()}>({parse(op.inner, k())})</React.Fragment>;
    } else {
      node = <React.Fragment key={k()}>{symbols(op.text)}</React.Fragment>;
    }
    let end = op.end;
    let scripted = false;
    for (let script = readScript(s, end); script; script = readScript(s, end)) {
      // A group that carries an exponent keeps its brackets: (x + 1)^2.
      if (!scripted && bare && op.kind === "group") node = <React.Fragment key={k()}>({parse(op.inner, k())})</React.Fragment>;
      scripted = true;
      node = <React.Fragment key={k()}>{node}<span style={script.type === "^" ? S.sup : S.sub}>{parse(script.inner, k())}</span></React.Fragment>;
      end = script.end;
    }
    return [node, end];
  };

  const scriptEnd = (op) => {
    let end = op.end;
    for (let script = readScript(s, end); script; script = readScript(s, end)) end = script.end;
    return end;
  };
  const solid = (op) => op.kind !== "token" || /\d/.test(op.text);

  for (let i = 0; i < s.length; ) {
    const op = readOperand(s, i);
    if (!op) {
      text += s[i];
      i += 1;
      continue;
    }
    const afterFirst = scriptEnd(op);
    const second = s[afterFirst] === "/" ? readOperand(s, afterFirst + 1) : null;
    // A stacked fraction needs a number or a bracket on at least one side
    // (so "m/s" stays as typed) and must not be part of a longer a/b/c run
    // (a date).
    if (second && (solid(op) || solid(second)) && s[i - 1] !== "/" && s[scriptEnd(second)] !== "/") {
      flush();
      const [top] = draw(op, true);
      const [bottom, end] = draw(second, true);
      out.push(<span key={k()} style={S.frac}><span style={S.num}>{top}</span><span style={S.den}>{bottom}</span></span>);
      i = end;
      continue;
    }
    if (op.kind === "token" && afterFirst === op.end) {
      // Nothing attached to it: it is just text.
      text += op.text;
      i = op.end;
      continue;
    }
    flush();
    const [node, end] = draw(op, false);
    out.push(node);
    i = end;
  }
  flush();
  return out;
}

export default function MathText({ text }) {
  if (typeof text !== "string" || !text) return text ?? null;
  return <>{parse(text)}</>;
}
