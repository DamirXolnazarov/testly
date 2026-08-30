/**
 * docs.js
 * Renders docs/exam-json-schema.md as a real in-app page, styled to match
 * the rest of Testly's own surfaces (see theme.js).
 *
 * This replaces the landing page's "Documentation" link, which previously
 * pointed at /docs/exam-json-schema.md — a path that was never actually
 * served (the real file lives at the repo root in docs/, not inside
 * frontend/public/docs, which only ever held the two sample JSON exams).
 * That link 404'd for every visitor who clicked it.
 *
 * getStaticProps reads the actual source-of-truth markdown file at build
 * time, so this page can never drift out of sync with the real schema doc —
 * there's nothing to manually keep updated when the schema changes.
 */
import fs from "fs";
import path from "path";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { COLORS } from "../lib/theme";

export async function getStaticProps() {
  // process.cwd() is the frontend/ directory during a Vercel build (this
  // project's Root Directory setting) — docs/ is a sibling of frontend/ at
  // the repo root. Wrapped defensively: if that assumption is ever wrong
  // (e.g. a different deployment root), this must not fail the whole site's
  // build — it falls back to a short message with a link to the doc on
  // GitHub instead of a 500.
  try {
    const filePath = path.join(process.cwd(), "..", "docs", "exam-json-schema.md");
    const markdown = fs.readFileSync(filePath, "utf8");
    return { props: { markdown } };
  } catch (e) {
    return {
      props: {
        markdown: `# Exam JSON Contract\n\nThe full schema doc couldn't be bundled with this build. You can view it directly on GitHub: https://github.com/DamirXolnazarov/testly/blob/main/docs/exam-json-schema.md`,
      },
    };
  }
}

/**
 * Minimal, dependency-free markdown renderer. Deliberately not a general
 * CommonMark implementation — it covers exactly the subset of markdown this
 * one document actually uses (headers, fenced code blocks, `inline code`,
 * **bold**, and `-` bullet lists), which is enough to render it correctly
 * without adding a new npm dependency for a single internal doc page.
 */
function renderMarkdown(md) {
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;
  let listBuffer = [];

  const flushList = () => {
    if (listBuffer.length) {
      blocks.push({ type: "ul", items: listBuffer });
      listBuffer = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      flushList();
      blocks.push({ type: "code", text: code.join("\n") });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      blocks.push({ type: "h2", text: line.slice(3) });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      flushList();
      blocks.push({ type: "h1", text: line.slice(2) });
      i++;
      continue;
    }
    if (line.trim().startsWith("- ")) {
      listBuffer.push(line.trim().slice(2));
      i++;
      continue;
    }
    flushList();
    if (line.trim() === "") {
      i++;
      continue;
    }
    blocks.push({ type: "p", text: line });
    i++;
  }
  flushList();
  return blocks;
}

/** Renders **bold** and `inline code` spans within a line of text. */
function renderInline(text, key) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, idx) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={`${key}-${idx}`}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={`${key}-${idx}`} className="doc-inline-code">{part.slice(1, -1)}</code>;
        }
        return <span key={`${key}-${idx}`}>{part}</span>;
      })}
    </>
  );
}

export default function Docs({ markdown }) {
  const blocks = renderMarkdown(markdown);

  return (
    <div className="doc-root">
      <style dangerouslySetInnerHTML={{ __html: `
        html, body, #__next { width:100%; min-height:100%; margin:0; }
        *, *::before, *::after { box-sizing:border-box; }
        .doc-root { min-height:100dvh; background:${COLORS.bg}; font-family:"Poppins",sans-serif; color:${COLORS.navy}; }
        .doc-header { display:flex; align-items:center; gap:10px; padding:20px clamp(20px, 5vw, 56px); border-bottom:1px solid ${COLORS.border}; background:#fff; }
        .doc-back { display:flex; align-items:center; gap:6px; color:${COLORS.navyMuted}; text-decoration:none; font-size:13.5px; font-weight:600; }
        .doc-back:hover { color:${COLORS.purple}; }
        .doc-body { max-width:760px; margin:0 auto; padding:clamp(24px, 5vw, 56px) 20px 80px; line-height:1.7; }
        .doc-body h1 { font-size:clamp(26px, 5vw, 34px); font-weight:800; margin:0 0 8px; }
        .doc-body h2 { font-size:clamp(19px, 3.5vw, 22px); font-weight:800; margin:36px 0 12px; }
        .doc-body p { font-size:14.5px; color:#333a52; margin:0 0 14px; word-wrap:break-word; }
        .doc-body ul { margin:0 0 14px; padding-left:22px; }
        .doc-body li { font-size:14.5px; color:#333a52; margin-bottom:6px; }
        .doc-inline-code { background:${COLORS.purpleSoft}; color:${COLORS.purple}; padding:2px 6px; border-radius:5px; font-size:13px; font-family:ui-monospace, monospace; }
        .doc-code-block { background:${COLORS.navy}; color:#e3e6f5; padding:16px 18px; border-radius:10px; overflow-x:auto; font-size:12.5px; line-height:1.6; margin:0 0 18px; font-family:ui-monospace, monospace; white-space:pre; }
      ` }} />
      <header className="doc-header">
        <Link href="/" className="doc-back"><ArrowLeft size={15} /> Back to Testly</Link>
      </header>
      <main className="doc-body">
        {blocks.map((b, idx) => {
          if (b.type === "h1") return <h1 key={idx}>{renderInline(b.text, idx)}</h1>;
          if (b.type === "h2") return <h2 key={idx}>{renderInline(b.text, idx)}</h2>;
          if (b.type === "code") return <pre key={idx} className="doc-code-block">{b.text}</pre>;
          if (b.type === "ul") return <ul key={idx}>{b.items.map((it, i2) => <li key={i2}>{renderInline(it, `${idx}-${i2}`)}</li>)}</ul>;
          return <p key={idx}>{renderInline(b.text, idx)}</p>;
        })}
      </main>
    </div>
  );
}
