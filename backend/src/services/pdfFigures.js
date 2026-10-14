/**
 * pdfFigures.js
 * Cuts a figure (a graph, a diagram, a chart) out of a page of an uploaded
 * PDF, so an imported question arrives with its picture instead of only a
 * note saying one is missing.
 *
 * The model that reads the paper (paperImporter.js) reports where each
 * figure is — the PDF page and a box in 0-1000 coordinates of that page,
 * [top, left, bottom, right]. This file renders the page with pdf.js and
 * crops the box out as a PNG. A box that is implausible (most of the page,
 * or a sliver) is rejected and the question simply stays flagged for the
 * teacher, which is the same outcome as before this existed.
 */

const RENDER_SCALE = 2; // twice the PDF's own resolution: crisp on a laptop screen
const PADDING = 12; // in 0-1000 units, so a box drawn a little tight doesn't clip labels

let pdfjsPromise = null;
function loadPdfjs() {
  // pdf.js ships as an ES module only.
  pdfjsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

/** Opens a PDF once for several crops. Pass the result to closePdf() when done. */
async function openPdf(buffer) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true }).promise;
}

/** Frees what pdf.js holds for an open document. */
async function closePdf(doc) {
  try {
    await (doc.loadingTask ? doc.loadingTask.destroy() : doc.cleanup?.());
  } catch {
    // nothing left worth reporting — the crops are already made
  }
}

/** True when a reported box is worth cropping. */
function plausible(box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(v))) return false;
  const [top, left, bottom, right] = box;
  const area = ((bottom - top) * (right - left)) / 1e6;
  return top >= 0 && left >= 0 && bottom <= 1000 && right <= 1000 && bottom > top && right > left && area >= 0.01 && area <= 0.7;
}

/**
 * @param {Object} doc - from openPdf()
 * @param {number} pageNumber - 1-based page of the PDF file
 * @param {number[]} box - [top, left, bottom, right] in 0-1000 page coordinates
 * @returns {Promise<Buffer|null>} PNG bytes, or null when the box is unusable
 */
async function cropFigure(doc, pageNumber, box) {
  if (!plausible(box) || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) return null;
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  // pdf.js leaves the page transparent; a figure on a dark UI needs paper white.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, canvas }).promise;

  const [top, left, bottom, right] = [
    Math.max(0, box[0] - PADDING), Math.max(0, box[1] - PADDING),
    Math.min(1000, box[2] + PADDING), Math.min(1000, box[3] + PADDING),
  ];
  const x = Math.floor((left / 1000) * canvas.width);
  const y = Math.floor((top / 1000) * canvas.height);
  const w = Math.ceil(((right - left) / 1000) * canvas.width);
  const h = Math.ceil(((bottom - top) / 1000) * canvas.height);

  // Tighten the box against what is actually drawn there.
  const pixels = context.getImageData(x, y, w, h);
  const trim = tightBounds(pixels.data, w, h);
  const { canvas: out, context: outContext } = doc.canvasFactory.create(trim.w, trim.h);
  outContext.fillStyle = "#ffffff";
  outContext.fillRect(0, 0, trim.w, trim.h);
  outContext.drawImage(canvas, x + trim.x, y + trim.y, trim.w, trim.h, 0, 0, trim.w, trim.h);
  page.cleanup();
  return out.toBuffer("image/png");
}

/**
 * Works out the part of a crop worth keeping: drops blank margins, and a
 * thin strip of content cut in at the top or bottom edge behind a blank
 * band — almost always the first or last line of the question text, which
 * a model's box tends to graze. Returns { x, y, w, h } within the crop.
 */
function tightBounds(rgba, w, h) {
  const MARGIN = 6; // px of white kept around the figure
  const inked = (i) => rgba[i] < 200 || rgba[i + 1] < 200 || rgba[i + 2] < 200;
  const rowInk = new Array(h).fill(false);
  const colInk = new Array(w).fill(false);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      if (inked((yy * w + xx) * 4)) { rowInk[yy] = true; colInk[xx] = true; }
    }
  }
  let top = rowInk.indexOf(true);
  let bottom = rowInk.lastIndexOf(true);
  if (top === -1) return { x: 0, y: 0, w, h }; // nothing drawn; leave it for a human
  const band = Math.max(6, Math.round(h * 0.015));

  // Find blank bands; if the content beyond the last (or before the first)
  // is a thin strip at the edge, it isn't part of the figure.
  const edgeStrip = (fromTop) => {
    let run = 0;
    const span = bottom - top;
    for (let step = 0; step <= span; step++) {
      const yy = fromTop ? top + step : bottom - step;
      if (!rowInk[yy]) { run += 1; continue; }
      if (run >= band) {
        // Ink resumed after a blank band: everything before it was a strip.
        return step - run <= span * 0.22 ? yy : null;
      }
      run = 0;
    }
    return null;
  };
  const cutBottomAt = edgeStrip(false);
  if (cutBottomAt !== null) bottom = cutBottomAt;
  const cutTopAt = edgeStrip(true);
  if (cutTopAt !== null) top = cutTopAt;

  // Columns are judged only over the rows that survived.
  colInk.fill(false);
  for (let yy = top; yy <= bottom; yy++) {
    for (let xx = 0; xx < w; xx++) if (inked((yy * w + xx) * 4)) colInk[xx] = true;
  }
  const left = Math.max(0, colInk.indexOf(true) - MARGIN);
  const right = Math.min(w - 1, colInk.lastIndexOf(true) + MARGIN);
  const y0 = Math.max(0, top - MARGIN);
  const y1 = Math.min(h - 1, bottom + MARGIN);
  return { x: left, y: y0, w: right - left + 1, h: y1 - y0 + 1 };
}

module.exports = { openPdf, closePdf, cropFigure };
