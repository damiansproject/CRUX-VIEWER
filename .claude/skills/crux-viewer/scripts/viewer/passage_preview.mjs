import { findQuote } from "./match.js";
import { bestPassage } from "./citations.mjs";
import { clipRangeRect, runAxis } from "./user_marks.mjs";

const previews = new Map();
const pending = new Map();

/** Render a passage crop without mounting a reader; open PDFs need their document's fonts. */
export async function sourcePreview(source, openPdf = null, ownerDocument = document) {
  const key = JSON.stringify([source.paper_id, source.page, source.text, source.related]);
  if (previews.has(key)) return previews.get(key);
  if (pending.has(key)) return pending.get(key);
  const job = renderPreview(source, openPdf, ownerDocument).then((result) => {
    previews.set(key, result);
    if (previews.size > 24) previews.delete(previews.keys().next().value);
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

async function renderPreview(source, openPdf, ownerDocument) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const url = `/pdf/${encodeURIComponent(source.paper_id)}`;
  let pageNumber = Number(source.page) || 1;
  let query = source.text;
  let exact = true;
  if (source.related) {
    const pages = [];
    if (openPdf) {
      for (let n = 1; n <= openPdf.numPages; n++) {
        pages.push(textIndex((await (await openPdf.getPage(n)).getTextContent()).items).text);
      }
    } else {
      const response = await fetch(`${url}?text=1`);
      if (!response.ok) throw new Error("Could not read the source passage. Open the paper to inspect it.");
      pages.push(...await response.json());
    }
    const hit = bestPassage(pages, query);
    if (!hit) return null;
    pageNumber = hit.page;
    query = pages[pageNumber - 1].slice(hit.spans[0].start, hit.spans.at(-1).end);
    exact = hit.exact;
  }
  const task = openPdf ? null : pdfjsLib.getDocument({ url: `${url}?page=${pageNumber}`, isEvalSupported: false });
  try {
    const pdf = openPdf || await task.promise;
    if (openPdf && (pageNumber < 1 || pageNumber > pdf.numPages)) return null;
    const page = await pdf.getPage(openPdf ? pageNumber : 1);
    const index = textIndex((await page.getTextContent()).items);
    let span = findQuote(index.text, query);
    // Text extraction order can differ; re-match on the actual displayed page.
    if (!span && source.related) {
      const hit = bestPassage([index.text], source.text);
      if (!hit) return null;
      span = { start: hit.spans[0].start, end: hit.spans.at(-1).end };
      exact = hit.exact;
    }
    if (!span) return null;
    const viewport = page.getViewport({ scale: 3 });
    const rows = index.ranges.filter((row) => row.end > row.start).map((row) => {
      const m = pdfjsLib.Util.transform(viewport.transform, row.item.transform);
      const em = row.item.height ? row.item.width / row.item.height : 0;
      const xs = [m[4], m[4] + m[0] * em, m[4] + m[2], m[4] + m[0] * em + m[2]];
      const ys = [m[5], m[5] + m[1] * em, m[5] + m[3], m[5] + m[1] * em + m[3]];
      const rect = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      return { ...row, rect, axis: runAxis(m[0] * em, m[1] * em) };
    });
    const rects = rows.filter((row) => row.end > span.start && row.start < span.end).map((row) =>
      clipRangeRect(row.rect, row.start, row.end, span.start, span.end, row.axis)).filter(Boolean);
    if (!rects.length) return null;
    const hitLeft = Math.min(...rects.map((r) => r.left));
    const hitRight = Math.max(...rects.map((r) => r.left + r.width));
    const hitTop = Math.min(...rects.map((r) => r.top));
    const hitBottom = Math.max(...rects.map((r) => r.top + r.height));
    // Keep neighbouring lines in the same column, rather than cutting through words.
    const context = rows.filter(({ rect: r }) => r.left < hitRight && r.left + r.width > hitLeft &&
      r.top + r.height > hitTop - 75 && r.top < hitBottom + 75);
    const left = Math.max(0, Math.min(...context.map(({ rect: r }) => r.left)) - 24);
    const right = Math.min(viewport.width, Math.max(...context.map(({ rect: r }) => r.left + r.width)) + 24);
    const firstLine = Math.min(...context.map(({ rect: r }) => r.top));
    const lastLine = Math.max(...context.map(({ rect: r }) => r.top + r.height));
    const column = rows.filter(({ rect: r }) => r.left < right && r.left + r.width > left);
    const above = Math.max(0, ...column.filter(({ rect: r }) => r.top + r.height <= firstLine).map(({ rect: r }) => r.top + r.height));
    const below = Math.min(viewport.height, ...column.filter(({ rect: r }) => r.top >= lastLine).map(({ rect: r }) => r.top));
    // End in the inter-line gaps so padding does not expose half of the next line.
    const top = Math.max(0, firstLine - Math.min(18, (firstLine - above) / 2));
    const bottom = Math.min(viewport.height, lastLine + Math.min(18, (below - lastLine) / 2));
    const canvas = ownerDocument.createElement("canvas");
    canvas.width = Math.ceil(right - left);
    canvas.height = Math.min(640, Math.ceil(bottom - top));
    const ctx = canvas.getContext("2d");
    // PDF.js supports rendering a viewport into an offset canvas; only the crop
    // is allocated (https://mozilla.github.io/pdf.js/examples/).
    await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -left, -top] }).promise;
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgba(255, 215, 72, .3)";
    for (const rect of rects) ctx.fillRect(rect.left - left, rect.top - top, rect.width, rect.height);
    return { page: pageNumber, text: index.text.slice(span.start, span.end), exact,
      context: index.text.slice(context[0].start, context.at(-1).end), width: canvas.width,
      image: canvas.toDataURL("image/png") };
  } finally { if (task) await task.destroy(); }
}

// Same text spacing as the reader, so its saved offsets and quote matcher agree.
function textIndex(items) {
  let text = "";
  const ranges = [];
  for (const item of items) {
    const value = item.str || "";
    if (text && !text.endsWith(" ") && value && !value.startsWith(" ")) text += " ";
    const start = text.length;
    text += value;
    ranges.push({ start, end: text.length, item });
  }
  return { text, ranges };
}
