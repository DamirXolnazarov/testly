import React from "react";
import MathText from "../shared/MathText";

/**
 * ExamPaper.jsx — read-only rendering of an exam's full JSON (see
 * docs/exam-json-schema.md) as a paper: used by Studio's preview panel and,
 * with `printable`, as the page that window.print() produces. Nothing here
 * edits the exam; answers are shown only when `showAnswers` is on.
 */

const SECTION_NAME = { reading: "Reading", listening: "Listening", writing: "Writing", "reading-writing": "Reading and Writing", math: "Math" };

export function sectionLabel(section) {
  return SECTION_NAME[section.type] || section.type;
}

function Answer({ value, show }) {
  if (!show || value === undefined || value === null || value === "") return null;
  const text = Array.isArray(value) ? value.join(" / ") : String(value);
  return <span className="ep-answer">{text}</span>;
}

function Question({ q, showAnswers }) {
  const head = q.groupTitle || q.groupInstructions ? (
    <div className="ep-group">
      {q.groupTitle && <strong>{q.groupTitle}</strong>}
      {q.groupInstructions && <span>{q.groupInstructions}</span>}
    </div>
  ) : null;

  let body = null;
  if (q.type === "gap-fill") {
    body = (
      <p className="ep-q">
        <b className="ep-n">{q.n}</b>
        {q.before} <span className="ep-blank">{showAnswers ? <Answer value={q.answer} show /> : ""}</span> {q.after}
      </p>
    );
  } else if (q.type === "table" && q.table) {
    body = (
      <div className="ep-scroll">
        <table className="ep-table">
          <thead><tr>{q.table.headers?.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>
            {q.table.rows?.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => {
                  const gap = q.gaps?.find((g) => g.cellMarker === cell);
                  return <td key={c}>{gap ? <><b className="ep-n">{gap.n}</b>{showAnswers ? <Answer value={gap.answer} show /> : <span className="ep-blank" />}</> : cell}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (q.type === "map") {
    body = (
      <p className="ep-q">
        <b className="ep-n">{q.points?.[0]?.n}{q.points?.length > 1 ? `–${q.points[q.points.length - 1].n}` : ""}</b>
        Map labelling{showAnswers && q.points ? <> {q.points.map((p) => <span key={p.id} className="ep-answer">{p.n}: {p.answer}</span>)}</> : null}
      </p>
    );
  } else {
    body = (
      <div className="ep-q">
        <p>
          <b className="ep-n">{q.n}</b>
          {q.passage && <em className="ep-qpassage">{q.passage}</em>}
          <MathText text={q.prompt || ""} />
          {q.type === "tfng" && !showAnswers && <span className="ep-hint">{q.variant === "yes-no" ? "YES / NO / NOT GIVEN" : "TRUE / FALSE / NOT GIVEN"}</span>}
          {q.type === "grid-in" && !showAnswers && <span className="ep-hint">Student-produced response</span>}
          <Answer value={q.answer} show={showAnswers && !Array.isArray(q.options)} />
        </p>
        {Array.isArray(q.options) && (
          <ol className="ep-options" type={q.optionLetters ? undefined : "A"}>
            {q.options.map((o, i) => (
              <li key={i} className={showAnswers && (o === q.answer || q.optionLetters?.[i] === q.answer) ? "right" : ""}>
                {q.optionLetters ? <b>{q.optionLetters[i]}</b> : null}<MathText text={String(o)} />
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  return <div className="ep-question">{head}{body}</div>;
}

function Questions({ list, showAnswers }) {
  if (!Array.isArray(list)) return null;
  // Matching groups share one option bank: show it once, above the first.
  let lastBank = null;
  return list.map((q, i) => {
    const bank = q.type === "matching" && Array.isArray(q.options) ? JSON.stringify(q.options) : null;
    const showBank = bank && bank !== lastBank;
    lastBank = bank;
    return (
      <React.Fragment key={q.id || i}>
        {showBank && (
          <ul className="ep-bank">{q.options.map((o, j) => <li key={j}><b>{q.optionLetters?.[j] || String.fromCharCode(65 + j)}</b> {o}</li>)}</ul>
        )}
        <Question q={bank ? { ...q, options: undefined } : q} showAnswers={showAnswers} />
      </React.Fragment>
    );
  });
}

function Notes({ items, showAnswers }) {
  if (!Array.isArray(items)) return null;
  return items.map((item, i) => (
    <div className="ep-notes" key={i}>
      {item.label && <strong>{item.label}</strong>}
      {item.lines?.map((line, j) => (
        <p key={j}>
          {line.pre} {line.text}
          {line.n != null && <><b className="ep-n">{line.n}</b><span className="ep-blank">{showAnswers ? <Answer value={line.answer ?? item.unorderedGroup?.answers?.join(", ")} show /> : ""}</span></>}
          {line.post ? ` ${line.post}` : ""}
        </p>
      ))}
    </div>
  ));
}

function Part({ part, showAnswers }) {
  return (
    <article className="ep-part">
      {part.title && <h3>{part.title}</h3>}
      {part.instructionsTitle && <div className="ep-group"><strong>{part.instructionsTitle}</strong></div>}
      {part.instructions && <p className="ep-instr">{part.instructions}</p>}
      {Array.isArray(part.passage) && part.passage.map((p, i) => <p className="ep-passage" key={i}>{p}</p>)}
      {part.prompt && <p className="ep-passage">{part.prompt}</p>}
      {part.minWords && !String(part.instructions || "").includes(String(part.minWords)) && <p className="ep-hint">Write at least {part.minWords} words.</p>}
      <Notes items={part.items} showAnswers={showAnswers} />
      <Questions list={part.questions} showAnswers={showAnswers} />
      {showAnswers && part.transcript && (
        <details className="ep-transcript"><summary>Audio script</summary><p>{part.transcript}</p></details>
      )}
    </article>
  );
}

function Module({ mod, showAnswers }) {
  const label = mod.stage === "module1" ? "Module 1" : `Module 2 · ${mod.difficulty === "hard" ? "harder" : "easier"}`;
  return (
    <article className="ep-part">
      <h3>{label}{mod.durationMinutes ? ` · ${mod.durationMinutes} min` : ""}</h3>
      <Questions list={mod.questions} showAnswers={showAnswers} />
    </article>
  );
}

export function SectionBody({ section, showAnswers }) {
  return (
    <>
      {(section.parts || []).map((part, i) => <Part key={part.id || i} part={part} showAnswers={showAnswers} />)}
      {(section.modules || []).map((mod, i) => <Module key={mod.id || i} mod={mod} showAnswers={showAnswers} />)}
    </>
  );
}

/** The whole exam as a paper: question booklet first, answer key after. */
export default function ExamPaper({ exam, showAnswers = false, printable = false }) {
  if (!exam) return null;
  return (
    <div className={`ep ${printable ? "ep-print" : ""}`}>
      <header className="ep-title">
        <h1>{exam.title}</h1>
        {printable && <p>{showAnswers ? "Answer key" : "Name: ______________________    Date: ______________"}</p>}
      </header>
      {(exam.sections || []).map((section, i) => (
        <section className="ep-section" key={section.id || `${section.type}${i}`}>
          <h2>{sectionLabel(section)}{section.durationMinutes ? <small> · {section.durationMinutes} min</small> : null}</h2>
          <SectionBody section={section} showAnswers={showAnswers} />
        </section>
      ))}
    </div>
  );
}
