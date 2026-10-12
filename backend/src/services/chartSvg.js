/**
 * chartSvg.js
 * Draws the chart for an AI-written IELTS Writing Task 1 as a standalone
 * SVG, from plain data ({ type, title, xLabel, yLabel, categories, series }).
 *
 * The model supplies the numbers and this file does the drawing, rather
 * than asking the model for an image: the figures in the picture are then
 * guaranteed to be the figures the task was written around, and the result
 * looks the same every time. Deliberately plain and monochrome-friendly,
 * like the charts on a real paper — it sits inside the IELTS replica UI,
 * not Testly's own branded surfaces.
 */

const WIDTH = 760;
const HEIGHT = 440;
const MARGIN = { top: 56, right: 24, bottom: 96, left: 68 };
const SERIES_COLORS = ["#2f4b7c", "#d9822b", "#3f8f6b", "#8a5fb0", "#c0504d"];
const FONT = "Arial, Helvetica, sans-serif";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNumber(n) {
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  return String(Math.round(n * 100) / 100);
}

/** Rounds the top of the axis up to a tidy number and returns the tick values. */
function axisTicks(maxValue) {
  if (maxValue <= 0) return [0, 1];
  const rough = maxValue / 5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) || 10 * magnitude;
  const ticks = [];
  for (let v = 0; v < maxValue + step - 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function renderTable(chart) {
  const columns = [chart.xLabel || "", ...chart.series.map((s) => s.name)];
  const rowHeight = 34;
  const tableWidth = WIDTH - 48;
  const firstCol = Math.min(240, tableWidth * 0.34);
  const otherCol = (tableWidth - firstCol) / chart.series.length;
  const top = 60;
  const height = top + rowHeight * (chart.categories.length + 1) + 24;
  const colX = (i) => 24 + (i === 0 ? 0 : firstCol + otherCol * (i - 1));
  const colW = (i) => (i === 0 ? firstCol : otherCol);

  const cells = [];
  columns.forEach((label, ci) => {
    cells.push(`<rect x="${colX(ci)}" y="${top}" width="${colW(ci)}" height="${rowHeight}" fill="#eceff3" stroke="#8a8f98"/>`);
    cells.push(`<text x="${colX(ci) + colW(ci) / 2}" y="${top + 22}" text-anchor="middle" font-weight="700">${esc(label)}</text>`);
  });
  chart.categories.forEach((category, ri) => {
    const y = top + rowHeight * (ri + 1);
    [category, ...chart.series.map((s) => formatNumber(s.values[ri]))].forEach((text, ci) => {
      cells.push(`<rect x="${colX(ci)}" y="${y}" width="${colW(ci)}" height="${rowHeight}" fill="#fff" stroke="#8a8f98"/>`);
      cells.push(`<text x="${colX(ci) + colW(ci) / 2}" y="${y + 22}" text-anchor="middle">${esc(text)}</text>`);
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" font-family="${FONT}" font-size="14" fill="#1a1a1a">
<rect width="${WIDTH}" height="${height}" fill="#fff"/>
<text x="${WIDTH / 2}" y="34" text-anchor="middle" font-size="16" font-weight="700">${esc(chart.title)}</text>
${cells.join("\n")}
</svg>`;
}

/**
 * @param {Object} chart - { type: "bar"|"line"|"table", title, xLabel, yLabel, categories: string[], series: [{ name, values: number[] }] }
 * @returns {string} SVG markup
 */
function renderChartSvg(chart) {
  if (chart.type === "table") return renderTable(chart);

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const maxValue = Math.max(0, ...chart.series.flatMap((s) => s.values));
  const ticks = axisTicks(maxValue);
  const top = ticks[ticks.length - 1];
  const y = (v) => MARGIN.top + plotH - (Math.max(0, v) / top) * plotH;
  const bandW = plotW / chart.categories.length;
  const out = [];

  ticks.forEach((t) => {
    out.push(`<line x1="${MARGIN.left}" y1="${y(t)}" x2="${MARGIN.left + plotW}" y2="${y(t)}" stroke="#d9dce1"/>`);
    out.push(`<text x="${MARGIN.left - 8}" y="${y(t) + 4}" text-anchor="end" font-size="12">${esc(formatNumber(t))}</text>`);
  });
  out.push(`<line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${MARGIN.top + plotH}" stroke="#1a1a1a"/>`);
  out.push(`<line x1="${MARGIN.left}" y1="${MARGIN.top + plotH}" x2="${MARGIN.left + plotW}" y2="${MARGIN.top + plotH}" stroke="#1a1a1a"/>`);

  chart.categories.forEach((category, i) => {
    out.push(`<text x="${MARGIN.left + bandW * (i + 0.5)}" y="${MARGIN.top + plotH + 20}" text-anchor="middle" font-size="12">${esc(category)}</text>`);
  });

  if (chart.type === "bar") {
    const groupW = bandW * 0.72;
    const barW = groupW / chart.series.length;
    chart.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const x = MARGIN.left + bandW * i + (bandW - groupW) / 2 + barW * si;
        out.push(`<rect x="${x}" y="${y(v)}" width="${Math.max(1, barW - 2)}" height="${MARGIN.top + plotH - y(v)}" fill="${SERIES_COLORS[si % SERIES_COLORS.length]}"/>`);
      });
    });
  } else {
    chart.series.forEach((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      const points = s.values.map((v, i) => `${MARGIN.left + bandW * (i + 0.5)},${y(v)}`);
      out.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"/>`);
      points.forEach((p) => {
        const [cx, cy] = p.split(",");
        out.push(`<circle cx="${cx}" cy="${cy}" r="3.5" fill="${color}"/>`);
      });
    });
  }

  // Legend, centred under the x-axis label.
  const legendItemW = Math.min(180, plotW / chart.series.length);
  const legendX = MARGIN.left + (plotW - legendItemW * chart.series.length) / 2;
  chart.series.forEach((s, si) => {
    const x = legendX + legendItemW * si;
    out.push(`<rect x="${x}" y="${HEIGHT - 26}" width="12" height="12" fill="${SERIES_COLORS[si % SERIES_COLORS.length]}"/>`);
    out.push(`<text x="${x + 18}" y="${HEIGHT - 15}" font-size="12">${esc(s.name)}</text>`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" font-family="${FONT}" font-size="14" fill="#1a1a1a">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#fff"/>
<text x="${WIDTH / 2}" y="30" text-anchor="middle" font-size="16" font-weight="700">${esc(chart.title)}</text>
${out.join("\n")}
<text x="${MARGIN.left + plotW / 2}" y="${MARGIN.top + plotH + 44}" text-anchor="middle" font-size="13">${esc(chart.xLabel)}</text>
<text transform="translate(18 ${MARGIN.top + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="13">${esc(chart.yLabel)}</text>
</svg>`;
}

module.exports = { renderChartSvg };
