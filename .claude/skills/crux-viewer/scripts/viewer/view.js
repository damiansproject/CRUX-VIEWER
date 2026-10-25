import { findAllQuotes, findQuote } from "./match.js";
import {
  INKS,
  boxFromPoints,
  clipRangeRect,
  clientRectsToLocal,
  clientToLocal,
  cycleInk,
  itemCharSlices,
  newMarkId,
  normalizeSpan,
  parseMarks,
  runAxis,
  shiftCssBox,
  textLayerTransform,
  underlineMarkRect,
} from "./user_marks.mjs";
import { mapPage, pageCoord, unmapT } from "./scroll_rail.mjs";
import { createLocationHistory } from "./location_history.mjs";
import {
  clampMenuPos,
  clipboardPngItems,
  cropBoxSource,
  menuActions,
  pngBlobFromDataUrl,
  quoteFromMark,
  quoteFromSelection,
  rightClickAction,
  spanFromDomRange,
} from "./selection_menu.mjs";
import {
  bestPassage,
  citationSpans,
  entryForAuthorYear,
  entryForNumeric,
  matchCatalog,
  parseCitations,
  referencesStart,
  referencesText,
  sentenceAround,
} from "./citations.mjs";

const paperId = decodeURIComponent(location.pathname.replace(/^\/reader\//, "").replace(/\/$/, ""));
if (parent === window) location.replace(`/view/${encodeURIComponent(paperId)}${location.hash}`);
const host = parent.cruxWorkspace;
// The back arrow unwinds the reader's own jumps (claim quotes, citations, find
// hits, typed pages) one at a time, like undo. Hand scrolling is never recorded;
// the Library has its own button in the rail.
const locHist = createLocationHistory();
document.getElementById("pdf-back-loc").onclick = () => replayLocation();
const initialView = host.readerState(window);
let readerActive = false;
let savedMarks = [];
const sidebar = parent.document;
// Only pages near the view hold a drawn canvas, as in Mozilla's pdf.js viewer: a
// 300-page PDF drawn whole is gigabytes of pixels, twice over while a zoom re-renders.
const DRAWN_PAGES = 12;
// pdf.js viewer limits: zoom to 1000%, and a page past 2^24 canvas pixels is drawn coarser and stretched
const MAX_ZOOM = 10;
const MAX_CANVAS_PIXELS = 16777216;

const well = document.getElementById("doc-well");
const claimsEl = sidebar.getElementById("claims");
const claimPane = sidebar.getElementById("claim-pane");
const statusEl = document.getElementById("status");
const bannerEl = document.getElementById("banner");
const titleEl = document.getElementById("title");
const metaEl = sidebar.getElementById("meta");
const toolbar = document.getElementById("pdf-toolbar");
const pdfControls = document.getElementById("pdf-controls");
const markDock = sidebar.getElementById("mark-dock");
const pageInput = document.getElementById("pdf-page");
const pageCountEl = document.getElementById("pdf-page-count");
const zoomInput = document.getElementById("pdf-zoom");
const findInput = document.getElementById("pdf-find");
const findCountEl = document.getElementById("pdf-find-count");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const paper = await fetch(`/api/paper/${encodeURIComponent(paperId)}`).then((r) => {
  if (!r.ok) throw new Error("paper not found");
  return r.json();
});
document.body.classList.toggle("is-report", paper.origin === "report");

document.title = paper.title.replace(/_/g, " ") + " · CRUX Viewer";
titleEl.textContent = paper.title.replace(/_/g, " ");


const claimHits = new Map();
for (const claim of paper.claims || []) {
  claimHits.set(claim.id, { found: 0, total: claimTargets(claim).length });
}

// A portal link lands as /view/<paper>#claim=<id>. The claim list re-renders as the
// source opens (PDF paint, iframe load), so the selection is re-applied after each
// render; the scroll and auto-expand happen once. Never gate this on the document
// finishing: a proxied page with a hanging subresource may never fire load.
// Citation portals add #q= (citing passage to land on), #from= (citing paper
// title, for the banner) and #embed=1 (chromeless, inside a portal frame).
const hashParams = new URLSearchParams(location.hash.slice(1));
let portalClaim = hashParams.get("claim") || null;
const portalQuery = (hashParams.get("q") || "").trim();
const portalFrom = (hashParams.get("from") || "").trim();
// Pre-located landings (#loc, a JSON list of {page, quote}) ride in from the
// citing viewer's warm-up so the preview needs no model call of its own; #z
// carries the citing viewer's scale so text renders at the same size.
const portalLoc = (() => {
  try {
    const rows = JSON.parse(hashParams.get("loc") || "null");
    return Array.isArray(rows) ? rows.slice(0, 3) : null;
  } catch {
    return null;
  }
})();
const portalZoom = Number(hashParams.get("z"));
const isEmbed = hashParams.get("embed") === "1";
if (isEmbed) document.body.classList.add("is-embed");
const BANNER_TTL = 6000;
let portalSettled = false;
const contextCache = new Map();
const expandedClaims = new Set();
if (portalClaim && !(paper.claims || []).some((c) => c.id === portalClaim)) {
  showBanner("That claim is not on this paper.");
  portalClaim = null;
}

const pdfUi = {
  pdf: null,
  quotesByPage: new Map(),
  pageData: new Map(),
  textCache: new Map(),
  textContent: new Map(),
  mode: initialView?.mode || "width",
  customScale: initialView?.customScale ?? null,
  scale: 1,
  rotation: initialView?.rotation || 0,
  page: initialView?.page || 1,
  observer: null,
  drawn: new Set(),
  drawObserver: null,
  findQuery: "",
  findHits: [],
  findIndex: -1,
  activeClaim: null,
  portalHits: null,
  portalIndex: 0,
  pageFieldFocused: false,
  rendering: false,
  resizeTimer: null,
  claimsReady: false,
  lastWell: null,
  lockPage: false,
  replaying: false,
  afterRender: [],
  replayChain: Promise.resolve(),
  gotoAnim: null,
  railAnim: false,
  railResize: false,
  railTimer: null,
  railLastOpen: 280,
};

const scrollUi = {
  bound: false,
  lens: 0,
  lensAnim: 0,
  hoverT: 0.5,
  dwell: 0,
  frozen: null,
  dragging: false,
  dragT: null,
  grabOffset: 0,
  morphFrom: null,
  morphU: 1,
  morphAnim: 0,
  raf: 0,
  findBuilt: null,
};

const markUi = {
  tool: "select",
  ink: "yellow",
  marks: [],
  selectedId: null,
  drag: null,
};

const selUi = {
  quote: null,
  range: null,
  mark: null,
  pos: null,
};

const portalUi = {
  catalog: null,
  refs: undefined,
  refsStart: undefined,
  zoneCache: null,
  zoneSpans: null,
  hoverTimer: 0,
  hoverGen: 0,
  hovered: null,
};

renderClaimList();
pdfUi.rail = {
  attachQuote: (quote) => host.attachQuote({ ...quote, paper_id: paperId }),
  showTab: (tab) => host.showTab(tab),
};
bindSelectionMenu();
document.addEventListener("pointerdown", () => { onCiteLeave(); host.hidePreview(); host.focus(window); }, true);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { onCiteLeave(); host.hidePreview(); } }, true);
well.addEventListener("pointermove", onCiteMove);
well.addEventListener("pointerleave", onCiteLeave);
well.addEventListener("scroll", onCiteLeave, { passive: true });
well.addEventListener("click", (event) => {
  if (markUi.tool !== "select" || event.target.closest(".pdf-link, .user-mark, .mark-handle") || !window.getSelection()?.isCollapsed) return;
  citationAtPoint(event)?.hit.link?.click();
});
window.addEventListener("focus", () => host.focus(window));

if (paper.origin === "web" || (!paper.pdf_ok && paper.source_url)) {
  if (paper.origin !== "web") showBanner("PDF not found on disk. Opened the live page instead.");
  await openWeb(paper);
} else if (paper.pdf_ok) {
  await openPdf(paper);
} else {
  showBanner("No PDF on disk and no URL to fetch.");
  statusEl.textContent = "No source file";
}

applyPortalClaim();
await applyPortalQuery();
if (initialView && pdfUi.pdf && !isPaged()) scrollToFractional(initialView.anchor);
/** Reader commands for the same-origin host; PDF state stays scoped to this frame.
 * Sidebar and markup controls belong to the host (MDN: HTMLIFrameElement.contentWindow).
 */
window.cruxReader = {
  paper,
  get pdf() { return pdfUi.pdf; },
  get marks() { return markUi.marks; },
  get page() { return pdfUi.page; },
  snapshot: () => ({ page: pdfUi.page, anchor: fractionalPage(), mode: pdfUi.mode,
    customScale: pdfUi.customScale, rotation: pdfUi.rotation }),
  activate: (id) => activate(id, "rail"),
  locate: locateSource,
  setActive(on) {
    readerActive = on;
    if (on) { renderClaimList(); tallyMissed(); syncMarkUi(); }
  },
  setTool,
  setInk,
  applyMarks(marks) {
    markUi.marks = structuredClone(marks);
    savedMarks = structuredClone(marks);
    paintAllUserPages();
  },
  resizeStart() {
    clearTimeout(pdfUi.resizeTimer);
    stopGoto();
    pdfUi.resizeAnchor = fractionalPage();
    pdfUi.observer?.disconnect();
    pdfUi.railResize = true;
    pdfUi.fitFrac = well.scrollTop / Math.max(1, well.scrollHeight - well.clientHeight);
  },
  resizeEnd() {
    pdfUi.railResize = false;
    if (shouldLiveFit()) {
      // Retain the rendered pages when only the available width changes.
      liveFitStack();
      pdfUi.fitFrac = null;
      pdfUi.lastWell = { w: well.clientWidth, h: well.clientHeight };
      scrollToFractional(pdfUi.resizeAnchor);
      bindPageObserver();
      scheduleScrollRail();
    } else if (pdfUi.pdf && !pdfUi.customScale) {
      clearStackFit();
      renderPdf({ restoreView: true, anchor: pdfUi.resizeAnchor });
    } else if (pdfUi.pdf && !isPaged()) bindPageObserver();
  },
};
host.ready(window);

async function locateSource(source) {
  if (!pdfUi.pdf) return;
  const pages = await allPageTexts();
  const hits = verifyPassages(pages, [{ page: source.page, quote: source.text }]);
  if (hits.length) {
    await landPortalHit(hits);
  } else {
    clearPortalHits();
    if (source.page) goToPage(source.page, { smooth: false });
    showBanner("Quote not found in this PDF. Check the page or select the passage manually.");
  }
}

function motion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function scrollChildInto(container, el) {
  if (!container || !el) return;
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const offset = eRect.top - cRect.top - cRect.height / 2 + eRect.height / 2;
  container.scrollTo({ top: container.scrollTop + offset, behavior: motion() });
}

function shortClaimId(id) {
  const m = String(id || "").match(/_(\d+)$/);
  return m ? m[1] : String(id || "");
}

function renderClaimList() {
  if (!readerActive) return;
  const claims = paper.claims || [];
  if (!claims.length) {
    claimsEl.innerHTML = `<li class="empty">No claims yet. Extract claims from this source to see its evidence here.</li>`;
    return;
  }
  claimsEl.innerHTML = claims
    .map((c) => {
      const hit = claimHits.get(c.id);
      const missed = hit && hit.total > 0 && hit.found === 0;
      const miss = missed ? `<span class="miss-note">Not found on page</span>` : "";
      const foreign = c.paper_id && c.paper_id !== paper.paper_id;
      return `<li>
        <article class="claim${c.id === pdfUi.activeClaim ? " is-active" : ""}${missed ? " missed" : ""}" data-claim="${escapeAttr(c.id)}" data-kind="${escapeAttr(c.kind || "other")}" tabindex="0">
          <div class="claim-meta">
            <span class="kind">${escapeHtml(c.kind || "other")}</span>
            <span class="id" title="${escapeAttr(c.id)}">${escapeHtml(shortClaimId(c.id))}</span>
          </div>
          <p class="statement">${escapeHtml(c.statement || "")}</p>
          ${miss}
          <div class="claim-actions">
            <button type="button" class="claim-expand" aria-expanded="false" data-claim="${escapeAttr(c.id)}">Quotes &amp; context</button>
            ${foreign ? `<a class="claim-portal" href="/view/${encodeURIComponent(c.paper_id)}#claim=${encodeURIComponent(c.id)}" title="Open ${escapeAttr(c.paper_id)} at this claim">Open source &rsaquo;</a>` : ""}
          </div>
          <div class="claim-context" hidden></div>
        </article>
      </li>`;
    })
    .join("");
  claimsEl.querySelectorAll(".claim").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".claim-expand, .claim-portal")) return;
      activate(el.dataset.claim, "rail");
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest(".claim-expand, .claim-portal")) return;
      e.preventDefault();
      activate(el.dataset.claim, "rail");
    });
  });
  claimsEl.querySelectorAll(".claim-expand").forEach((btn) => {
    btn.addEventListener("click", () => toggleClaimContext(btn));
    if (expandedClaims.has(btn.dataset.claim)) openClaimContext(btn);
  });
  applyPortalClaim();
}

function applyPortalClaim() {
  if (!readerActive || !portalClaim) return;
  const card = claimsEl.querySelector(`[data-claim="${cssEscape(portalClaim)}"]`);
  if (!card) return;
  activate(portalClaim, "rail");
  if (portalSettled) return;
  portalSettled = true;
  pdfUi.rail?.showTab?.("claims");
  scrollChildInto(claimsEl.parentElement, card);
  const btn = card.querySelector(".claim-expand");
  if (btn) toggleClaimContext(btn);
}

// The cited-paper side of a citation portal: land on the passage that best
// matches the citing text. An exact hit on a quoted phrase wins outright;
// otherwise local term overlap offers related text, labelled as unverified.
async function applyPortalQuery() {
  if (!portalQuery && !portalLoc) return;
  if (!pdfUi.pdf) {
    if (portalFrom) showBanner(`Opened from “${portalFrom}”.`, BANNER_TTL);
    return;
  }
  const pages = await allPageTexts();
  const from = portalFrom ? `Opened from “${portalFrom}” — ` : "";
  // pre-located by the citing viewer's warm-up: verify and land, no model call
  if (portalLoc) {
    const hits = verifyPassages(pages, portalLoc);
    if (hits.length) {
      await landPortalHit(hits);
      showBanner(from + passagesLabel(hits), BANNER_TTL);
      return;
    }
  }
  if (!portalQuery) {
    showBanner(`${from}no matching passage found.`, BANNER_TTL);
    return;
  }
  const hit = bestPassage(pages, portalQuery);
  if (hit) await landPortalHit(hit);
  if (hit?.exact) {
    showBanner(`${from}exact quote shown.`, BANNER_TTL);
    return;
  }
  showBanner(hit ? `${from}related text shown; the cited passage is not verified.` : `${from}no matching passage found.`, BANNER_TTL);
}

function passagesLabel(hits) {
  return hits.length > 1 ? `${hits.length} cited passages shown.` : "cited passage shown.";
}

// Model-claimed passages are only real once they fold-match a page verbatim.
function verifyPassages(pages, rows) {
  const hits = [];
  for (const row of rows || []) {
    const quote = String(row?.quote || "").trim();
    if (!quote) continue;
    const hint = Number(row?.page);
    for (const n of pageSearchOrder(Number.isInteger(hint) && hint >= 1 ? hint : 1, pages.length)) {
      const span = findQuote(pages[n - 1], quote);
      if (!span) continue;
      if (!hits.some((h) => h.page === n && h.spans[0].start === span.start)) {
        hits.push({ page: n, spans: [span], quote, exact: false });
      }
      break;
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

function jumpToPortalHit(hit, { smooth = false } = {}) {
  const data = pdfUi.pageData.get(hit.page);
  let extra = 0;
  const rect = data && hit.spans[0] ? spanRects(data, hit.spans[0].start, hit.spans[0].end)[0] : null;
  if (rect) extra = Math.max(0, rect.top - Math.max(60, well.clientHeight * 0.3));
  goToPage(hit.page, { smooth, forceScroll: true, history: false, extra });
  // a zoomed preview is narrower than its page: align to the passage's
  // column start so no line begins off-screen
  if (rect && data?.wrap && well.scrollWidth > well.clientWidth + 4) {
    const col = columnBounds(data, hit.spans) || { left: rect.left, right: rect.left + rect.width };
    const pad = Math.max(10, (wellViewWidth() - (col.right - col.left)) / 2);
    const pageX = data.wrap.getBoundingClientRect().left - well.getBoundingClientRect().left + well.scrollLeft;
    const target = pageX + col.left - pad;
    const left = Math.max(0, Math.min(target, well.scrollWidth - well.clientWidth));
    well.scrollTo({ left, behavior: smooth ? motion() : "auto" });
  }
}

// The scroll rail overlays the well's right edge; anything fitted or centred
// in a preview must not end up underneath it.
function wellViewWidth() {
  return well.clientWidth - (isEmbed ? 38 : 0);
}

// The text column the hit lives in: every text run that overlaps the hit
// horizontally and sits within a few lines vertically. Bounded so a stray
// full-width caption cannot drag the column out to the page edges.
function columnBounds(data, spans) {
  const rects = (spans || []).flatMap((s) => spanRects(data, s.start, s.end));
  if (!rects.length) return null;
  const hitL = Math.min(...rects.map((r) => r.left));
  const hitR = Math.max(...rects.map((r) => r.left + r.width));
  const hitT = Math.min(...rects.map((r) => r.top));
  const hitB = Math.max(...rects.map((r) => r.top + r.height));
  let left = hitL;
  let right = hitR;
  for (const r of data.ranges) {
    if (r.start === r.end) continue;
    const run = itemRun(r.item, data.viewport).rect;
    if (run.width < 1 || run.height < 1) continue;
    if (run.left >= hitR || run.left + run.width <= hitL) continue;
    if (run.top >= hitB + 240 || run.top + run.height <= hitT - 240) continue;
    left = Math.min(left, run.left);
    right = Math.max(right, run.left + run.width);
  }
  return { left, right };
}

// In a preview, keep the citing page's text size when the passage's column
// fits the card, and shrink only as far as needed to fit the column — a line
// that starts or ends off-screen is worse than slightly smaller text.
async function fitPortalHit(hit) {
  if (!isEmbed) return;
  const data = pdfUi.pageData.get(hit.page);
  if (!data) return;
  const col = columnBounds(data, hit.spans);
  if (!col) return;
  const avail = Math.max(120, wellViewWidth() - 20);
  const width = col.right - col.left;
  if (width <= avail + 2) return;
  const next = Math.max(0.25, pdfUi.scale * (avail / width));
  if (next >= pdfUi.scale - 0.01) return;
  pdfUi.customScale = next;
  await renderPdf();
}

async function landPortalHit(hits) {
  const list = (Array.isArray(hits) ? hits : [hits]).filter(Boolean);
  if (!list.length) return;
  rememberLocation();
  document.querySelectorAll(".portal-hit").forEach((n) => n.remove());
  pdfUi.portalHits = list;
  pdfUi.portalIndex = 0;
  paintPortalHits();
  updatePortalPager();
  await fitPortalHit(list[0]);
  jumpToPortalHit(list[0]);
}

function paintPortalHits() {
  (pdfUi.portalHits || []).forEach((hit, i) => {
    const data = pdfUi.pageData.get(hit.page);
    if (!data) return;
    for (const span of hit.spans) {
      paintSpan(data.hlLayer, data.ranges, data.viewport, span, "portal-hit", (div) => {
        if (i === pdfUi.portalIndex) div.classList.add("is-current");
      }, data.textLayer);
    }
  });
}

// Prev / next through the located passages, like the find tool's counter.
async function showPortalHit(i) {
  const list = pdfUi.portalHits || [];
  if (!list.length) return;
  pdfUi.portalIndex = ((i % list.length) + list.length) % list.length;
  document.querySelectorAll(".portal-hit").forEach((n) => n.remove());
  paintPortalHits();
  updatePortalPager();
  const hit = list[pdfUi.portalIndex];
  rememberLocation();
  await fitPortalHit(hit);
  jumpToPortalHit(hit, { smooth: true });
}

function updatePortalPager() {
  const list = pdfUi.portalHits || [];
  let pager = document.getElementById("portal-pager");
  if (list.length < 2) {
    pager?.remove();
    return;
  }
  if (!pager) {
    pager = document.createElement("div");
    pager.id = "portal-pager";
    pager.className = "portal-pager";
    pager.innerHTML = `<button type="button" class="hud-btn" data-nav="-1" title="Previous passage" aria-label="Previous passage">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M10.2 3.2 L5.2 8 l5 4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="portal-pager-count" aria-live="polite"></span>
      <button type="button" class="hud-btn" data-nav="1" title="Next passage" aria-label="Next passage">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5.8 3.2 L10.8 8 l-5 4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
    pager.querySelectorAll("[data-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        showPortalHit(pdfUi.portalIndex + Number(btn.dataset.nav)).catch(() => {});
      });
    });
    document.getElementById("stage").appendChild(pager);
  }
  pager.querySelector(".portal-pager-count").textContent =
    `${pdfUi.portalIndex + 1} / ${list.length}`;
}

function clearPortalHits() {
  pdfUi.portalHits = null;
  pdfUi.portalIndex = 0;
  document.getElementById("portal-pager")?.remove();
  document.querySelectorAll(".portal-hit").forEach((n) => n.remove());
  bannerEl.hidden = true;
}

async function allPageTexts() {
  const out = [];
  for (let n = 1; n <= pdfUi.pdf.numPages; n++) out.push(await haystackForPage(n));
  return out;
}

function toggleClaimContext(btn) {
  if (btn.getAttribute("aria-expanded") === "true") {
    expandedClaims.delete(btn.dataset.claim);
    btn.setAttribute("aria-expanded", "false");
    btn.closest(".claim").querySelector(".claim-context").hidden = true;
    return;
  }
  expandedClaims.add(btn.dataset.claim);
  openClaimContext(btn);
}

// Painting the document re-renders the claim list, so expansions are restored
// from expandedClaims rather than living in the DOM.
async function openClaimContext(btn) {
  const pane = btn.closest(".claim").querySelector(".claim-context");
  btn.setAttribute("aria-expanded", "true");
  pane.hidden = false;
  const id = btn.dataset.claim;
  if (contextCache.has(id)) {
    pane.innerHTML = renderClaimContext(contextCache.get(id));
    return;
  }
  pane.innerHTML = `<p class="context-note">Loading…</p>`;
  try {
    const r = await fetch(`/api/claim/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error("no context");
    contextCache.set(id, await r.json());
    if (expandedClaims.has(id)) pane.innerHTML = renderClaimContext(contextCache.get(id));
  } catch {
    pane.innerHTML = `<p class="context-note">Could not load quotes for this claim.</p>`;
  }
}

function renderClaimContext(data) {
  const quotes = data.quotes || [];
  if (!quotes.length) return `<p class="context-note">This claim stores no quotes.</p>`;
  const source = data.source || {};
  const head = source.title
    ? `<p class="context-source">${escapeHtml(source.title)}</p>`
    : data.paper_id
      ? `<p class="context-source">${escapeHtml(data.paper_id)}</p>`
      : "";
  return head + quotes
    .map((q) => {
      const page = q.page != null ? `<span class="context-page">p. ${escapeHtml(String(q.page))}</span>` : "";
      const body = q.located
        ? `<span class="context-around">…${escapeHtml(q.before)}</span><mark>${escapeHtml(q.text)}</mark><span class="context-around">${escapeHtml(q.after)}…</span>`
        : `<mark>${escapeHtml(q.text)}</mark>`;
      const note = q.located
        ? ""
        : `<span class="context-note">${data.has_source_text ? "Not found in the converted source" : "Converted source text not available"}</span>`;
      return `<blockquote class="context-quote">${page}${body}${note}</blockquote>`;
    })
    .join("");
}

function tallyMissed() {
  if (!readerActive) return;
  let missed = 0;
  for (const hit of claimHits.values()) {
    if (hit.total > 0 && hit.found === 0) missed += 1;
  }
  const base = `${paper.origin} · ${paper.claim_count} claims · ${paper.quote_count} quotes`;
  metaEl.textContent = missed ? `${base} · ${missed} unmatched` : base;
}

function markNodes(claimId) {
  const sel = `[data-claim="${cssEscape(claimId)}"]`;
  const nodes = [...document.querySelectorAll(`.hl${sel}, mark.crux-quote${sel}`)];
  const iframe = well.querySelector("iframe");
  if (iframe && iframe.contentDocument) {
    nodes.push(...iframe.contentDocument.querySelectorAll(`mark.crux-quote${sel}`));
  }
  return nodes;
}

function activate(claimId, source) {
  if (source === "doc") host.focus(window);
  if (markUi.selectedId) {
    markUi.selectedId = null;
    paintAllUserPages();
    syncMarkUi();
  }
  pdfUi.activeClaim = claimId;
  if (readerActive) {
    claimsEl.querySelectorAll(".claim.is-active").forEach((n) => n.classList.remove("is-active"));
  }
  document.querySelectorAll(".hl.is-active").forEach((n) => {
    n.classList.remove("is-active");
  });
  const iframe = well.querySelector("iframe");
  if (iframe && iframe.contentDocument) {
    iframe.contentDocument.querySelectorAll("mark.crux-quote.is-active").forEach((n) => {
      n.classList.remove("is-active");
    });
  }
  const card = readerActive ? claimsEl.querySelector(`[data-claim="${cssEscape(claimId)}"]`) : null;
  if (card) card.classList.add("is-active");
  const marks = markNodes(claimId);
  marks.forEach((n) => n.classList.add("is-active"));
  if (source === "rail") {
    const target = marks[0];
    if (target && target.ownerDocument !== document) {
      target.scrollIntoView({ block: "center", behavior: motion() });
    } else if (target) {
      rememberLocation();
      scrollChildInto(well, target);
    }
  } else if (source === "doc" && card) {
    pdfUi.rail?.showTab?.("claims");
    scrollChildInto(claimPane, card);
  }
}

// Errors stay until acted on; informational banners (portal landings) pass a
// ttl and fade away on their own.
function showBanner(text, ttl = 0) {
  clearTimeout(pdfUi.bannerTtl);
  clearTimeout(pdfUi.bannerFade);
  bannerEl.classList.remove("is-fading");
  bannerEl.hidden = false;
  bannerEl.textContent = text;
  if (!ttl) return;
  pdfUi.bannerTtl = setTimeout(() => {
    bannerEl.classList.add("is-fading");
    pdfUi.bannerFade = setTimeout(() => {
      bannerEl.hidden = true;
      bannerEl.classList.remove("is-fading");
    }, 600);
  }, ttl);
}

// Filename-derived titles read as "02_Persona_Vectors_Chen_2025" — show them
// as words wherever a human reads them; ids stay untouched.
function displayTitle(s) {
  return String(s || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function recordHit(claimId) {
  const hit = claimHits.get(claimId);
  if (hit) hit.found += 1;
}

// What to paint for a claim in THIS document: a report cites a claim on its own
// clause (the anchor), so highlight that; a source paper is painted on the claim's
// own quotes. Either way the pane keeps showing the banked quotes.
function claimTargets(claim) {
  if (claim.anchor) return [{ text: claim.anchor, locator: null }];
  return claim.quotes || [];
}

function resetHits() {
  for (const hit of claimHits.values()) hit.found = 0;
}

function textIndex(items) {
  let haystack = "";
  const ranges = [];
  for (let i = 0; i < items.length; i++) {
    const str = items[i].str || "";
    if (i > 0 && haystack && !haystack.endsWith(" ") && str && !str.startsWith(" ")) {
      haystack += " ";
    }
    const start = haystack.length;
    haystack += str;
    ranges.push({ start, end: haystack.length, item: items[i] });
  }
  return { haystack, ranges };
}

function paintSpan(layer, ranges, viewport, span, className, setup, textLayer) {
  const painted = paintSpanFromTextLayer(layer, ranges, span, className, setup, textLayer);
  if (painted) return;
  for (const r of ranges) {
    if (r.end <= span.start || r.start >= span.end || r.start === r.end) continue;
    const run = itemRun(r.item, viewport);
    const rect = clipRangeRect(run.rect, r.start, r.end, span.start, span.end, run.axis);
    if (!rect) continue;
    appendPaintedRect(layer, rect, className, setup);
  }
}

function paintSpanFromTextLayer(layer, ranges, span, className, setup, textLayer) {
  if (!textLayer) return false;
  const pairs = zipTextSpans(textLayer, ranges);
  if (!pairs) return false;
  let any = false;
  for (const { range: r, el } of pairs) {
    if (r.end <= span.start || r.start >= span.end) continue;
    const from = Math.max(r.start, span.start) - r.start;
    const to = Math.min(r.end, span.end) - r.start;
    if (to <= from) continue;
    for (const rect of textRangeRects(el, from, to, layer)) {
      appendPaintedRect(layer, rect, className, setup);
      any = true;
    }
  }
  return any;
}

function zipTextSpans(textLayer, ranges) {
  const domSpans = [...textLayer.querySelectorAll(":scope > span")];
  const nonempty = ranges.filter((r) => r.start !== r.end);
  if (!domSpans.length || !nonempty.length) return null;
  if (domSpans.length === nonempty.length) {
    return nonempty.map((range, i) => ({ range, el: domSpans[i] }));
  }
  const out = [];
  let j = 0;
  for (const range of nonempty) {
    const want = range.item?.str ?? "";
    let found = -1;
    for (let k = j; k < domSpans.length; k++) {
      if ((domSpans[k].textContent || "") === want) {
        found = k;
        break;
      }
    }
    if (found < 0) return null;
    out.push({ range, el: domSpans[found] });
    j = found + 1;
  }
  return out;
}

function textRangeRects(el, from, to, layer) {
  const node = spanTextNode(el);
  if (!node) return [];
  const len = node.nodeValue.length;
  const a = Math.max(0, Math.min(len, from));
  const b = Math.max(a, Math.min(len, to));
  if (b <= a) return [];
  const range = document.createRange();
  range.setStart(node, a);
  range.setEnd(node, b);
  return clientRectsToLocal(layer.getBoundingClientRect(), layer.offsetWidth, layer.offsetHeight, [
    ...range.getClientRects(),
  ]);
}

function spanTextNode(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) return node;
  }
  return null;
}

function appendPaintedRect(layer, rect, className, setup) {
  const div = document.createElement("div");
  div.className = className;
  if (setup) setup(div);
  div.style.left = `${rect.left}px`;
  div.style.top = `${rect.top}px`;
  div.style.width = `${rect.width}px`;
  div.style.height = `${rect.height}px`;
  layer.appendChild(div);
}

async function openPdf() {
  pdfControls.hidden = false;
  host.setMarkupAvailable(window, true);
  document.getElementById("scroll-rail").hidden = false;
  statusEl.textContent = "Rendering PDF";
  if (isEmbed && Number.isFinite(portalZoom) && portalZoom > 0) {
    pdfUi.customScale = Math.min(MAX_ZOOM, Math.max(0.25, portalZoom));
  }
  pdfUi.pdf = await pdfjsLib.getDocument({ url: `/pdf/${encodeURIComponent(paper.paper_id)}`, isEvalSupported: false }).promise;
  await placeQuotes();
  pageInput.max = String(pdfUi.pdf.numPages);
  pageCountEl.textContent = String(pdfUi.pdf.numPages);
  const labels = await pdfUi.pdf.getPageLabels();
  // a book's own numbering (i, ii, 1, 2, ...) when it differs from the PDF's page order, as pdf.js shows it
  pdfUi.labels = labels?.some((label, i) => label !== String(i + 1)) ? labels : null;
  document.querySelector(".pdf-of").hidden = Boolean(pdfUi.labels);
  showPage(pdfUi.page);
  bindPdfToolbar();
  await loadMarks();
  await renderPdf();
}

function isPaged() {
  return pdfUi.mode === "single" || pdfUi.mode === "double";
}

function pageStep() {
  return pdfUi.mode === "double" ? 2 : 1;
}

function visiblePages() {
  const n = pdfUi.pdf.numPages;
  const p = Math.min(Math.max(1, pdfUi.page), n);
  if (pdfUi.mode === "single") return [p];
  if (pdfUi.mode === "double") {
    const start = p % 2 === 0 ? p - 1 : p;
    const pages = [Math.max(1, start)];
    if (pages[0] + 1 <= n) pages.push(pages[0] + 1);
    return pages;
  }
  return Array.from({ length: n }, (_, i) => i + 1);
}

// A page's text is the same at every zoom, and pdf.js re-parses it on every call:
// 300 pages took the worker about 1.7 s per zoom click.
function textContentOf(page) {
  if (!pdfUi.textContent.has(page.pageNumber)) pdfUi.textContent.set(page.pageNumber, page.getTextContent());
  return pdfUi.textContent.get(page.pageNumber);
}

async function haystackForPage(n) {
  if (pdfUi.pageData.has(n)) return pdfUi.pageData.get(n).haystack;
  if (pdfUi.textCache.has(n)) return pdfUi.textCache.get(n);
  const page = await pdfUi.pdf.getPage(n);
  const tc = await textContentOf(page);
  const items = tc.items.filter((it) => it && it.str != null);
  const { haystack } = textIndex(items);
  pdfUi.textCache.set(n, haystack);
  return haystack;
}

function pageHint(quote) {
  const n = Number(quote?.locator?.page);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function pageSearchOrder(hint, nPages) {
  const out = [];
  for (const n of [hint, hint - 1, hint + 1]) {
    if (n >= 1 && n <= nPages && !out.includes(n)) out.push(n);
  }
  for (let n = 1; n <= nPages; n++) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

async function placeQuotes() {
  pdfUi.quotesByPage = new Map();
  resetHits();
  const nPages = pdfUi.pdf.numPages;
  for (const claim of paper.claims || []) {
    for (const quote of claimTargets(claim)) {
      for (const n of pageSearchOrder(pageHint(quote), nPages)) {
        const haystack = await haystackForPage(n);
        if (!findQuote(haystack, quote.text || "")) continue;
        if (!pdfUi.quotesByPage.has(n)) pdfUi.quotesByPage.set(n, []);
        pdfUi.quotesByPage.get(n).push({ claim, quote });
        recordHit(claim.id);
        break;
      }
    }
  }
}

async function scaleForFit() {
  if (pdfUi.customScale) return pdfUi.customScale;
  const page = await pdfUi.pdf.getPage(visiblePages()[0] || 1);
  const vp = page.getViewport({ scale: 1, rotation: (page.rotate + pdfUi.rotation) % 360 });
  const availW = Math.max(120, well.clientWidth - 48);
  const availH = Math.max(120, well.clientHeight - 28);
  if (pdfUi.mode === "width") return availW / vp.width;
  if (pdfUi.mode === "height") return availH / vp.height;
  if (pdfUi.mode === "double") {
    return Math.min(availW / (vp.width * 2 + 16), availH / vp.height);
  }
  return Math.min(availW / vp.width, availH / vp.height);
}

function drawPage(data) {
  if (data.drawing) {
    pdfUi.drawn.delete(data);  // most recently wanted goes last
    pdfUi.drawn.add(data);
    return data.drawing;
  }
  const { canvas, viewport, dpr } = data;
  const ratio = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  data.task = data.page.render({ canvasContext: ctx, viewport });
  data.drawing = data.task.promise.catch(() => {});
  pdfUi.drawn.add(data);
  for (const old of pdfUi.drawn) {
    if (pdfUi.drawn.size <= DRAWN_PAGES) break;
    if (old !== data && !old.near) releasePage(old);
  }
  return data.drawing;
}

function releasePage(data) {
  data.task?.cancel();
  data.canvas.width = 0;
  data.canvas.height = 0;
  data.drawing = null;
  data.task = null;
  pdfUi.drawn.delete(data);
}

async function renderOnePage(n, stack, dpr, pageData, drawObserver) {
  const page = await pdfUi.pdf.getPage(n);
  const viewport = page.getViewport({ scale: pdfUi.scale, rotation: (page.rotate + pdfUi.rotation) % 360 });
  const wrap = document.createElement("div");
  wrap.className = "pdf-page";
  wrap.dataset.page = String(n);
  wrap.style.width = `${viewport.width}px`;
  wrap.style.height = `${viewport.height}px`;
  const canvas = document.createElement("canvas");
  canvas.width = 0;  // drawn by drawPage once the page nears the view
  canvas.height = 0;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const hl = document.createElement("div");
  hl.className = "hl-layer";
  const findLayer = document.createElement("div");
  findLayer.className = "find-layer";
  const linkLayer = document.createElement("div");
  linkLayer.className = "link-layer";
  const userLayer = document.createElement("div");
  userLayer.className = "user-layer";
  const handleLayer = document.createElement("div");
  handleLayer.className = "handle-layer";
  const citeLayer = document.createElement("div");
  citeLayer.className = "cite-layer";
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  wrap.append(canvas, textLayer, findLayer, hl, linkLayer, citeLayer, userLayer, handleLayer);
  stack.appendChild(wrap);
  const tc = await textContentOf(page);
  const items = tc.items.filter((it) => it && it.str != null);
  const index = textIndex(items);
  pdfUi.textCache.set(n, index.haystack);
  const data = { ...index, page, canvas, dpr, viewport, findLayer, wrap, userLayer, handleLayer, citeLayer, textLayer, hlLayer: hl };
  pageData.set(n, data);
  drawObserver.observe(wrap);
  await paintTextLayer(textLayer, viewport, tc);
  await paintLinks(page, viewport, linkLayer);
  paintUserPage(data);
  wrap.addEventListener("pointerdown", (e) => onMarkPointerDown(e, n), true);
}

async function renderPdf({ restoreView = false, anchor = null } = {}) {
  if (!pdfUi.pdf) return;
  if (pdfUi.rendering) {
    pdfUi.needsRender = true;
    return;
  }
  const frac = restoreView && !isPaged() ? anchor ?? fractionalPage() : null;
  pdfUi.rendering = true;
  pdfUi.ignoreResize = true;
  const keepPage = pdfUi.page;
  const nextData = new Map();
  try {
    pdfUi.scale = await scaleForFit();
    zoomInput.value = `${Math.round(pdfUi.scale * 100)}%`;
    if (pdfUi.observer) {
      pdfUi.observer.disconnect();
      pdfUi.observer = null;
    }
    const stack = document.createElement("div");
    stack.className = "pdf-stack";
    if (isPaged()) stack.classList.add("paged");
    if (pdfUi.mode === "double") stack.classList.add("spread");
    const dpr = window.devicePixelRatio || 1;
    const pages = visiblePages();
    const drawObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const data = nextData.get(Number(entry.target.dataset.page));
        if (!data) continue;
        data.near = entry.isIntersecting;
        if (data.near) drawPage(data);
      }
    }, { root: well, rootMargin: "150% 0px" });
    // First render paints progressively — the reader sees page 1 in the time
    // one page takes, not the whole document. Re-renders (zoom, resize) keep
    // building off-DOM so the current view never flickers away.
    const progressive = !pdfUi.claimsReady && !isPaged() && pages.length > 4;
    if (progressive) well.replaceChildren(stack);
    let done = 0;
    for (const n of pages) {
      await renderOnePage(n, stack, dpr, nextData, drawObserver);
      done += 1;
      if (progressive && done < pages.length) {
        statusEl.textContent = `Rendering page ${done} of ${pages.length}`;
      }
    }
    if (!progressive) {
      // draw the pages that will show before swapping, so a zoom never flashes blank
      const height = nextData.get(keepPage)?.viewport.height || well.clientHeight;
      const showing = Math.min(DRAWN_PAGES - 1, Math.ceil(well.clientHeight / height) + 1);
      for (let n = keepPage - 1; n <= keepPage + showing; n += 1) {
        if (nextData.has(n)) await drawPage(nextData.get(n));
      }
      well.replaceChildren(stack);
    }
    const outgoing = pdfUi.pageData;
    pdfUi.pageData = nextData;
    pdfUi.drawObserver?.disconnect();
    pdfUi.drawObserver = drawObserver;
    for (const data of outgoing.values()) if (data.drawing) releasePage(data);
    for (const [n, data] of nextData) {
      data.hlLayer.replaceChildren();
      await paintClaims(n, data, data.viewport, data.hlLayer, data.textLayer);
    }
    paintPortalHits();
    paintAllCiteZones().catch(() => {});
    if (isPaged()) {
      well.scrollTo({ top: 0, behavior: "auto" });
      showPage(Number(pdfUi.page));
    } else if (pdfUi.pendingPage) {
      goToPage(pdfUi.pendingPage, { smooth: false, forceScroll: true, history: false });  // asked for before it existed
    } else if (frac != null) {
      scrollToFractional(frac);
    } else if (!progressive || well.scrollTop < 8) {
      // someone already reading mid-load must not be yanked back to page 1
      goToPage(keepPage, { smooth: false, forceScroll: true, history: false });
    }
    if (!pdfUi.claimsReady) {
      renderClaimList();
      tallyMissed();
      pdfUi.claimsReady = true;
    }
    paintFindHits();
    updateFindCount();
    paintAllUserPages();
    if (!isPaged()) bindPageObserver();
    layoutScrollRail();
    if (pdfUi.activeClaim) activate(pdfUi.activeClaim, "none");
    statusEl.textContent = `${pdfUi.pdf.numPages} pages`;
  } finally {
    pdfUi.rendering = false;
    if (shouldLiveFit()) liveFitStack();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pdfUi.lastWell = { w: well.clientWidth, h: well.clientHeight };
        pdfUi.ignoreResize = false;
      });
    });
    if (pdfUi.needsRender) {
      pdfUi.needsRender = false;
      await renderPdf();
    }
    if (!pdfUi.rendering && pdfUi.afterRender.length) {
      const waiting = pdfUi.afterRender;
      pdfUi.afterRender = [];
      waiting.forEach((fn) => fn());
    }
  }
}

async function paintTextLayer(container, viewport, textContent) {
  container.style.setProperty("--scale-factor", String(viewport.scale));
  // renderTextLayer lays glyphs out unrotated; without the container transform
  // the official viewer applies, every DOM-measured rect ignores rotation.
  container.style.transform = textLayerTransform(viewport.rotation);
  const render = pdfjsLib.renderTextLayer;
  if (typeof render !== "function") return;
  const task = render({
    textContentSource: textContent,
    container,
    viewport,
  });
  try {
    await task.promise;
  } catch {
    /* cancelled during re-render */
  }
}

async function paintClaims(n, index, viewport, layer, textLayer) {
  const entries = pdfUi.quotesByPage.get(n) || [];
  for (const { claim, quote } of entries) {
    const span = findQuote(index.haystack, quote.text || "");
    if (!span) continue;
    paintSpan(layer, index.ranges, viewport, span, "hl", (div) => {
      div.dataset.claim = claim.id;
      div.dataset.kind = claim.kind || "other";
      div.dataset.start = String(span.start);
      div.dataset.end = String(span.end);
      div.addEventListener("click", (e) => {
        e.stopPropagation();
        activate(claim.id, "doc");
      });
    }, textLayer);
  }
}

function httpUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function destCommand(slot) {
  if (!slot) return "";
  if (typeof slot === "string") return slot;
  return slot.name || "";
}

async function resolveDest(dest) {
  let explicit = dest;
  if (typeof dest === "string") {
    explicit = await pdfUi.pdf.getDestination(dest);
  }
  if (!Array.isArray(explicit) || explicit[0] == null) return null;
  let pageNumber;
  try {
    pageNumber = (await pdfUi.pdf.getPageIndex(explicit[0])) + 1;
  } catch {
    if (typeof explicit[0] === "number") pageNumber = explicit[0] + 1;
    else return null;
  }
  const name = destCommand(explicit[1]);
  let pdfY = null;
  if (name === "XYZ") pdfY = explicit[3];
  else if (name === "FitH" || name === "FitBH") pdfY = explicit[2];
  return { pageNumber, pdfY };
}

async function jumpDest(dest) {
  const loc = await resolveDest(dest);
  if (!loc) return;
  let extra = 0;
  const data = pdfUi.pageData.get(loc.pageNumber);
  if (data && loc.pdfY != null && Number.isFinite(loc.pdfY)) {
    extra = data.viewport.convertToViewportPoint(0, loc.pdfY)[1];
  }
  goToPage(loc.pageNumber, { extra });
}

function annotBox(viewport, rect) {
  const v = viewport.convertToViewportRectangle(rect);
  const left = Math.min(v[0], v[2]);
  const top = Math.min(v[1], v[3]);
  return { left, top, width: Math.abs(v[2] - v[0]), height: Math.abs(v[3] - v[1]) };
}

async function paintLinks(page, viewport, layer) {
  const annots = await page.getAnnotations({ intent: "display" });
  for (const annot of annots) {
    if (annot.subtype !== "Link" && annot.subtype !== "link") continue;
    if (!annot.rect) continue;
    const box = annotBox(viewport, annot.rect);
    if (box.width < 2 || box.height < 2) continue;
    const a = document.createElement("a");
    a.className = "pdf-link";
    a.style.left = `${box.left}px`;
    a.style.top = `${box.top}px`;
    a.style.width = `${box.width}px`;
    a.style.height = `${box.height}px`;
    const href = httpUrl(annot.url) || httpUrl(annot.unsafeUrl);
    if (href) {
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = href;
      const link = new URL(href);
      if (link.hostname === "crux.local" && link.pathname.startsWith("/claim/")) {
        const source = { claim_id: decodeURIComponent(link.pathname.slice(7)) };
        a.title = "Show source passage";
        a.addEventListener("pointerenter", () => host.citation(window, source, a.getBoundingClientRect(), false));
        a.addEventListener("click", (event) => {
          event.preventDefault();
          host.citation(window, source, a.getBoundingClientRect(), true);
        });
      }
    } else if (annot.dest) {
      a.href = "#";
      a.title = "Go to destination";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        jumpDest(annot.dest);
      });
    } else {
      continue;
    }
    layer.appendChild(a);
  }
}

function bindPageObserver() {
  pdfUi.observer = new IntersectionObserver(
    (entries) => {
      if (pdfUi.pageFieldFocused || pdfUi.lockPage) return;
      let best = null;
      let ratio = 0;
      for (const entry of entries) {
        if (entry.intersectionRatio > ratio) {
          ratio = entry.intersectionRatio;
          best = entry.target;
        }
      }
      if (!best || ratio < 0.15) return;
      const n = Number(best.dataset.page);
      if (!n || n === pdfUi.page) return;
      pdfUi.page = n;
      showPage(Number(n));
    },
    { root: well, threshold: [0.15, 0.35, 0.55, 0.75] },
  );
  well.querySelectorAll(".pdf-page").forEach((el) => pdfUi.observer.observe(el));
}

function setFindOpen(open) {
  const slot = document.getElementById("find-slot");
  const toggle = document.getElementById("pdf-find-toggle");
  if (!slot || !toggle) return;
  slot.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    requestAnimationFrame(() => {
      findInput.focus();
      findInput.select();
    });
  }
}

/** Where the well is now, or null while replaying or before a PDF is open. */
function currentLocation() {
  if (pdfUi.replaying || !pdfUi.pdf) return null;
  return {
    page: pdfUi.page, top: well.scrollTop, left: well.scrollLeft, anchor: fractionalPage(),
    scale: pdfUi.scale, rotation: pdfUi.rotation, extent: well.scrollHeight, width: well.scrollWidth,
  };
}

/** The fractional page the well would show at the given scroll offset (continuous modes). */
function fractionalAt(top) {
  const pages = [...well.querySelectorAll(".pdf-page")];
  if (!pages.length) return pdfUi.page;
  const y = top + 8;
  for (const el of pages) {
    // rendered heights: width mode fits the stack with a CSS scale, so the
    // native offsetHeight overstates every page
    const docTop = pageDocY(el);
    const h = el.getBoundingClientRect().height;
    if (docTop + h > y) {
      const t = h ? (y - docTop) / h : 0;
      return Number(el.dataset.page) + Math.min(0.999, Math.max(0, t));
    }
  }
  return Number(pages[pages.length - 1].dataset.page);
}

/** Run after the render in flight (and any it queued) has settled; at once when none is. */
function whenRenderSettles(fn) {
  if (!pdfUi.rendering) fn();
  else pdfUi.afterRender.push(fn);
}

function keepLocation(snap) {
  if (snap && locHist.remember(snap)) syncLocBack();
}

/** Remember where the well is now so the back arrow can return here. */
function rememberLocation() {
  keepLocation(currentLocation());
}

function syncLocBack() {
  const btn = document.getElementById("pdf-back-loc");
  if (btn) btn.disabled = locHist.size === 0;
}

/** Return to the location remembered before the latest jump. */
function replayLocation() {
  const snap = locHist.pop();
  syncLocBack();
  if (!snap || !pdfUi.pdf) return;
  // replays run one at a time, each once the render in flight has settled: a
  // second click while the first is still rendering waits for its landing
  pdfUi.replayChain = pdfUi.replayChain.then(
    () => new Promise((done) => whenRenderSettles(() => landLocation(snap).finally(done))),
  );
}

async function landLocation(snap) {
  pdfUi.replaying = true;
  try {
    stopGoto();
    pdfUi.page = snap.page;
    showPage(Number(snap.page));
    if (isPaged() && !well.querySelector(`.pdf-page[data-page="${snap.page}"]`)) {
      try {
        await renderPdf();
      } catch {
        /* the landing below still applies to whatever rendered */
      }
    }
    // the raw offsets are exact while the layout is unchanged; after a zoom, a
    // rotation or a refit the fractional page still lands on the same spot
    const sameLayout = snap.scale === pdfUi.scale && snap.rotation === pdfUi.rotation &&
      snap.extent === well.scrollHeight && snap.width === well.scrollWidth;
    if (sameLayout) {
      well.scrollTop = snap.top;
    } else if (isPaged()) {
      // in paged modes the anchor's fraction is the share of the page's own scroll range
      const max = Math.max(0, well.scrollHeight - well.clientHeight);
      const frac = Math.min(1, Math.max(0, ((snap.anchor ?? snap.page) - snap.page) / 0.99));
      well.scrollTop = frac * max;
    } else {
      scrollToFractional(snap.anchor ?? snap.page);
    }
    const ratio = snap.width ? well.scrollWidth / snap.width : 1;
    well.scrollLeft = Math.min(Math.max(0, well.scrollWidth - well.clientWidth), (snap.left || 0) * ratio);
    pdfUi.page = snap.page;
    showPage(Number(snap.page));
    scheduleScrollRail();
  } finally {
    pdfUi.replaying = false;
  }
}

function showPage(n) {
  pageInput.value = pdfUi.labels?.[n - 1] || String(n);
  if (pdfUi.labels) pageCountEl.textContent = `(${n} of ${pdfUi.pdf.numPages})`;
}

function pageFromInput(text) {
  const labels = pdfUi.labels || [];
  const exact = labels.indexOf(String(text));
  const index = exact >= 0 ? exact : labels.indexOf(String(text).trim());
  return index >= 0 ? index + 1 : text;
}

function goToPage(n, { smooth = true, forceScroll = false, extra = 0, history = true } = {}) {
  const page = Math.min(Math.max(1, Math.round(Number(n) || 1)), pdfUi.pdf.numPages);
  const fromPage = pdfUi.page;
  // the origin is kept only when the well actually moves: a typed page number
  // arrives twice (Enter, then the field's blur) and the repeat is not a jump
  const origin = history ? currentLocation() : null;
  const before = visiblePages().join(",");
  pdfUi.page = page;
  showPage(Number(page));
  if (isPaged()) {
    const after = visiblePages().join(",");
    if (before !== after || !well.querySelector(`.pdf-page[data-page="${page}"]`)) {
      // only a real page change is a jump: a typed page's blur repeat arrives
      // while that page is still rendering
      if (page !== fromPage) keepLocation(origin);
      renderPdf();
      return;
    }
  }
  const wrap = well.querySelector(`.pdf-page[data-page="${page}"]`);
  pdfUi.pendingPage = wrap ? null : page;  // a long PDF still loading: go there when it has rendered
  if (!wrap) return;
  if (isPaged() && !forceScroll) return;
  const cRect = well.getBoundingClientRect();
  const eRect = wrap.getBoundingClientRect();
  const top = well.scrollTop + (eRect.top - cRect.top) + extra - 8;
  // a jump issued while a smooth jump is still in flight is measured from where
  // that jump will settle, so the field's blur repeat lands as no move at all
  const inFlight = pdfUi.gotoAnim?.target;
  if (Math.abs(top - (inFlight ?? well.scrollTop)) > 2) {
    if (origin && inFlight != null) {
      origin.top = inFlight;
      if (!isPaged()) origin.anchor = fractionalAt(inFlight);
    }
    keepLocation(origin);
  }
  if (wantsSmoothJump(fromPage, page, smooth)) animateWellScroll(top);
  else {
    stopGoto();
    well.scrollTo({ top, behavior: "auto" });
  }
}

function wantsSmoothJump(fromPage, toPage, smooth) {
  return Boolean(smooth) && motion() === "smooth" && Math.abs(toPage - fromPage) <= 5;
}

function stopGoto({ sync = false } = {}) {
  if (pdfUi.gotoAnim) {
    cancelAnimationFrame(pdfUi.gotoAnim.raf);
    pdfUi.gotoAnim = null;
  }
  pdfUi.lockPage = false;
  if (sync) syncPageFromView();
}

function syncPageFromView() {
  if (pdfUi.pageFieldFocused || isPaged()) return;
  const root = well.getBoundingClientRect();
  let best = null;
  let bestVis = 0;
  well.querySelectorAll(".pdf-page").forEach((el) => {
    const r = el.getBoundingClientRect();
    const vis = Math.max(0, Math.min(r.bottom, root.bottom) - Math.max(r.top, root.top));
    if (vis > bestVis) {
      bestVis = vis;
      best = el;
    }
  });
  const n = Number(best?.dataset.page);
  if (!n) return;
  pdfUi.page = n;
  showPage(Number(n));
}

function animateWellScroll(top) {
  stopGoto();
  const start = well.scrollTop;
  const dist = top - start;
  if (Math.abs(dist) < 1) return;
  pdfUi.lockPage = true;
  const duration = Math.min(520, Math.max(280, Math.abs(dist) * 0.35));
  const t0 = performance.now();
  const anim = { raf: 0, target: top };
  pdfUi.gotoAnim = anim;
  const ease = (t) => 1 - (1 - t) ** 3;
  const step = (now) => {
    if (pdfUi.gotoAnim !== anim) return;
    const t = Math.min(1, (now - t0) / duration);
    well.scrollTop = start + dist * ease(t);
    scheduleScrollRail();
    if (t < 1) {
      anim.raf = requestAnimationFrame(step);
      return;
    }
    pdfUi.gotoAnim = null;
    pdfUi.lockPage = false;
  };
  anim.raf = requestAnimationFrame(step);
}

function pageDocY(el) {
  return el.getBoundingClientRect().top - well.getBoundingClientRect().top + well.scrollTop;
}

function fractionalPage() {
  if (!pdfUi.pdf) return 1;
  if (isPaged()) {
    const max = well.scrollHeight - well.clientHeight;
    const frac = max > 0 ? well.scrollTop / max : 0;
    return pdfUi.page + frac * 0.99;
  }
  const pages = [...well.querySelectorAll(".pdf-page")];
  if (!pages.length) return pdfUi.page;
  const y = well.getBoundingClientRect().top + 8;
  for (const el of pages) {
    const r = el.getBoundingClientRect();
    if (r.bottom > y) {
      const p = Number(el.dataset.page);
      const t = r.height ? (y - r.top) / r.height : 0;
      return p + Math.min(0.999, Math.max(0, t));
    }
  }
  return Number(pages[pages.length - 1].dataset.page);
}

function mappingNow() {
  if (scrollUi.frozen) return scrollUi.frozen;
  const live = {
    focus: fractionalPage(),
    n: pdfUi.pdf.numPages,
    hoverT: scrollUi.hoverT,
    lens: scrollUi.lens,
  };
  if (scrollUi.morphFrom != null && scrollUi.morphU < 1) {
    return {
      ...live,
      focus: scrollUi.morphFrom + (live.focus - scrollUi.morphFrom) * scrollUi.morphU,
    };
  }
  return live;
}

function cancelMorph() {
  if (scrollUi.morphAnim) cancelAnimationFrame(scrollUi.morphAnim);
  scrollUi.morphAnim = 0;
  scrollUi.morphFrom = null;
  scrollUi.morphU = 1;
}

function animateMorph(fromFocus) {
  cancelMorph();
  const to = fractionalPage();
  if (!Number.isFinite(fromFocus) || Math.abs(fromFocus - to) < 0.04) {
    layoutScrollRail();
    return;
  }
  scrollUi.morphFrom = fromFocus;
  scrollUi.morphU = 0;
  layoutScrollRail();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ms = reduced ? 1 : 420;
  const t0 = performance.now();
  const step = (now) => {
    const u = Math.min(1, (now - t0) / ms);
    scrollUi.morphU = 1 - (1 - u) ** 3;
    layoutScrollRail();
    if (u < 1) scrollUi.morphAnim = requestAnimationFrame(step);
    else cancelMorph();
  };
  scrollUi.morphAnim = requestAnimationFrame(step);
}

function tFromEvent(e) {
  const track = document.getElementById("scroll-track");
  const ticksEl = document.getElementById("scroll-ticks");
  const rect = track.getBoundingClientRect();
  const pad = 6;
  const h = Math.max(1, ticksEl.clientHeight || rect.height - pad * 2);
  const y = e.clientY - (scrollUi.grabOffset || 0);
  return Math.min(1, Math.max(0, (y - rect.top - pad) / h));
}

function scrollToFractional(page) {
  const n = pdfUi.pdf.numPages;
  const p = Math.min(n + 0.999, Math.max(1, page));
  const lo = Math.min(n, Math.max(1, Math.floor(p)));
  const hi = Math.min(n, lo + 1);
  const a = well.querySelector(`.pdf-page[data-page="${lo}"]`);
  const b = well.querySelector(`.pdf-page[data-page="${hi}"]`) || a;
  if (!a) {
    goToPage(Math.round(p), { smooth: false, history: false });
    return;
  }
  const y0 = pageDocY(a);
  // the rendered height: width mode fits the stack with a CSS scale
  const y1 = b === a ? y0 + a.getBoundingClientRect().height : pageDocY(b);
  well.scrollTop = y0 + (p - lo) * (y1 - y0) - 8;
  pdfUi.page = Math.min(n, Math.round(p));
  showPage(Number(pdfUi.page));
}

function seekRail(e, { live = false } = {}) {
  stopGoto();
  const t = tFromEvent(e);
  if (live) scrollUi.dragT = t;
  const page = unmapT(t, mappingNow());
  if (live && !isPaged()) {
    scrollToFractional(page);
    layoutScrollRail();
    return;
  }
  goToPage(Math.round(page), { smooth: !live, history: !live });
}

function scheduleScrollRail() {
  if (scrollUi.raf) return;
  scrollUi.raf = requestAnimationFrame(() => {
    scrollUi.raf = 0;
    layoutScrollRail();
  });
}

function findHitCoord(hit) {
  const data = pdfUi.pageData.get(hit.page);
  if (data?.viewport?.height) {
    const rects = spanRects(data, hit.start, hit.end);
    if (rects[0]) return pageCoord(hit.page, rects[0].top, data.viewport.height);
  }
  const len = data?.haystack?.length || pdfUi.textCache.get(hit.page)?.length || 0;
  return pageCoord(hit.page, hit.start, len);
}

function layoutFindTicks(innerH, map) {
  const findEl = document.getElementById("scroll-find");
  if (!findEl) return;
  const hits = pdfUi.findHits;
  if (scrollUi.findBuilt !== hits) {
    scrollUi.findBuilt = hits;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < hits.length; i++) {
      const tick = document.createElement("div");
      tick.className = "scroll-find-tick";
      frag.appendChild(tick);
    }
    findEl.replaceChildren(frag);
  }
  hits.forEach((hit, i) => {
    const tick = findEl.children[i];
    if (!tick) return;
    tick.style.top = `${mapPage(findHitCoord(hit), map) * innerH}px`;
    tick.classList.toggle("is-current", i === pdfUi.findIndex);
  });
}

function layoutScrollRail() {
  const rail = document.getElementById("scroll-rail");
  const track = document.getElementById("scroll-track");
  const ticksEl = document.getElementById("scroll-ticks");
  const thumb = document.getElementById("scroll-thumb");
  if (!pdfUi.pdf || rail.hidden) return;
  const n = pdfUi.pdf.numPages;
  const map = mappingNow();
  const innerH = Math.max(1, ticksEl.clientHeight || track.clientHeight - 12);
  if (ticksEl.childElementCount !== n) {
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= n; i++) {
      const tick = document.createElement("div");
      tick.className = "scroll-tick";
      tick.dataset.page = String(i);
      frag.appendChild(tick);
    }
    ticksEl.replaceChildren(frag);
  }
  const livePage = Math.round(
    scrollUi.dragging && scrollUi.dragT != null ? unmapT(scrollUi.dragT, map) : fractionalPage(),
  );
  for (let p = 1; p <= n; p++) {
    const tick = ticksEl.children[p - 1];
    tick.style.top = `${mapPage(p, map) * innerH}px`;
    tick.style.width = "";
    tick.style.height = "";
    tick.classList.toggle("is-current", p === livePage);
  }
  layoutFindTicks(innerH, map);
  const THUMB_H = 28;
  const t =
    scrollUi.dragging && scrollUi.dragT != null
      ? scrollUi.dragT
      : mapPage(fractionalPage(), map);
  const top = Math.min(Math.max(0, t * innerH - THUMB_H / 2), Math.max(0, innerH - THUMB_H));
  thumb.style.top = `${top + 6}px`;
  thumb.style.height = `${THUMB_H}px`;
  thumb.setAttribute("aria-valuemin", "1");
  thumb.setAttribute("aria-valuemax", String(n));
  thumb.setAttribute("aria-valuenow", String(livePage));
}

function animateLens(to) {
  if (scrollUi.lensAnim) cancelAnimationFrame(scrollUi.lensAnim);
  const from = scrollUi.lens;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ms = reduced ? 1 : to > from ? 420 : 280;
  const t0 = performance.now();
  const rail = document.getElementById("scroll-rail");
  const step = (now) => {
    const u = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - u) ** 3;
    scrollUi.lens = from + (to - from) * e;
    rail.classList.toggle("is-lens", scrollUi.lens > 0.08);
    layoutScrollRail();
    if (u < 1) scrollUi.lensAnim = requestAnimationFrame(step);
    else scrollUi.lensAnim = 0;
  };
  scrollUi.lensAnim = requestAnimationFrame(step);
}

function clearDwell() {
  if (scrollUi.dwell) {
    clearTimeout(scrollUi.dwell);
    scrollUi.dwell = 0;
  }
}

function bindScrollRail() {
  if (scrollUi.bound) return;
  scrollUi.bound = true;
  const rail = document.getElementById("scroll-rail");
  const track = document.getElementById("scroll-track");
  const thumb = document.getElementById("scroll-thumb");
  well.addEventListener("scroll", scheduleScrollRail, { passive: true });
  well.addEventListener(
    "wheel",
    () => {
      if (scrollUi.morphFrom == null) return;
      cancelMorph();
      layoutScrollRail();
    },
    { passive: true },
  );
  thumb.addEventListener("pointerenter", (e) => {
    if (scrollUi.dragging) return;
    rail.classList.add("is-hot");
    scrollUi.hoverT = tFromEvent(e);
    clearDwell();
    scrollUi.dwell = setTimeout(() => animateLens(1), 2000);
  });
  thumb.addEventListener("pointerleave", () => {
    rail.classList.remove("is-hot");
    if (scrollUi.dragging) return;
    clearDwell();
    if (scrollUi.lens > 0) animateLens(0);
  });
  thumb.addEventListener("pointermove", (e) => {
    scrollUi.hoverT = tFromEvent(e);
    if (scrollUi.lens > 0 && !scrollUi.dragging) scheduleScrollRail();
  });
  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearDwell();
    const thumbRect = thumb.getBoundingClientRect();
    scrollUi.grabOffset = e.clientY - (thumbRect.top + thumbRect.height / 2);
    const snap = mappingNow();
    cancelMorph();
    scrollUi.dragging = true;
    scrollUi.dragT = tFromEvent(e);
    scrollUi.frozen = snap;
    thumb.setPointerCapture(e.pointerId);
    seekRail(e, { live: true });
  });
  thumb.addEventListener("pointermove", (e) => {
    if (!scrollUi.dragging) return;
    scrollUi.hoverT = tFromEvent(e);
    seekRail(e, { live: true });
  });
  const endDrag = (e) => {
    if (!scrollUi.dragging) return;
    const fromFocus = mappingNow().focus;
    scrollUi.dragging = false;
    scrollUi.frozen = null;
    scrollUi.dragT = null;
    scrollUi.grabOffset = 0;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (over !== thumb && !thumb.contains(over)) {
      rail.classList.remove("is-hot");
      if (scrollUi.lens > 0) animateLens(0);
    }
    animateMorph(fromFocus);
  };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);
  track.addEventListener("pointerdown", (e) => {
    if (e.target === thumb) return;
    scrollUi.hoverT = tFromEvent(e);
    seekRail(e);
  });
  rail.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      stopGoto();
      if (scrollUi.morphFrom != null) {
        cancelMorph();
        layoutScrollRail();
      }
      well.scrollTop += e.deltaY;
    },
    { passive: false },
  );
}

function applyZoom(next) {
  pdfUi.customScale = Math.min(MAX_ZOOM, Math.max(0.25, next));
  renderPdf();
}

function displayedScale() {
  const page = well.querySelector(".pdf-page");
  return page ? pdfUi.scale * page.getBoundingClientRect().width / page.offsetWidth : pdfUi.scale;
}

async function runFind(query) {
  pdfUi.findQuery = query.trim();
  pdfUi.findHits = [];
  pdfUi.findIndex = -1;
  if (pdfUi.findQuery) {
    for (let n = 1; n <= pdfUi.pdf.numPages; n++) {
      const haystack = await haystackForPage(n);
      for (const span of findAllQuotes(haystack, pdfUi.findQuery)) {
        pdfUi.findHits.push({ page: n, ...span });
      }
    }
    if (pdfUi.findHits.length) pdfUi.findIndex = 0;
  }
  paintFindHits();
  updateFindCount();
  scheduleScrollRail();
  if (pdfUi.findIndex >= 0) showFindHit(pdfUi.findIndex);
}

function paintFindHits() {
  for (const data of pdfUi.pageData.values()) {
    data.findLayer.replaceChildren();
  }
  pdfUi.findHits.forEach((hit, i) => {
    const data = pdfUi.pageData.get(hit.page);
    if (!data) return;
    paintSpan(data.findLayer, data.ranges, data.viewport, hit, "find-hit", (div) => {
      if (i === pdfUi.findIndex) div.classList.add("is-current");
    }, data.textLayer);
  });
}

function updateFindCount() {
  if (!pdfUi.findQuery) {
    findCountEl.textContent = "";
    return;
  }
  if (!pdfUi.findHits.length) {
    findCountEl.textContent = "0 matches";
    return;
  }
  findCountEl.textContent = `${pdfUi.findIndex + 1} of ${pdfUi.findHits.length}`;
}

function showFindHit(i) {
  if (!pdfUi.findHits.length) return;
  pdfUi.findIndex = (i + pdfUi.findHits.length) % pdfUi.findHits.length;
  const hit = pdfUi.findHits[pdfUi.findIndex];
  if (!pdfUi.pageData.has(hit.page)) {
    goToPage(hit.page);
    return;
  }
  paintFindHits();
  updateFindCount();
  scheduleScrollRail();
  const current = pdfUi.pageData.get(hit.page)?.findLayer.querySelector(".find-hit.is-current");
  rememberLocation();
  if (current) scrollChildInto(well, current);
  else goToPage(hit.page);
}

function markKey() {
  return `crux-lit-marks:v1:${paper.paper_id}`;
}

async function loadMarks() {
  let disk = [];
  try {
    const r = await fetch(`/api/marks/${encodeURIComponent(paper.paper_id)}`);
    if (r.ok) disk = parseMarks(await r.json());
  } catch {
    disk = [];
  }
  if (disk.length) {
    markUi.marks = disk;
    savedMarks = structuredClone(disk);
    return;
  }
  try {
    const local = parseMarks(JSON.parse(localStorage.getItem(markKey()) || "null"));
    markUi.marks = local;
    if (local.length) saveMarks();
  } catch {
    markUi.marks = [];
  }
}

function saveMarks() {
  host.saveMarks(window, savedMarks, markUi.marks);
  savedMarks = structuredClone(markUi.marks);
}

function syncMarkUi() {
  well.dataset.tool = markUi.tool;
  if (readerActive) host.syncTools(markUi.tool, markUi.ink);
  for (const name of ["select", "highlight", "box", "underline"]) {
    const btn = document.getElementById(`tool-${name}`);
    if (!btn) continue;
    const on = markUi.tool === name;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  document.querySelectorAll("#ink-swatches .ink").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.ink === markUi.ink);
  });
}

function setTool(tool) {
  markUi.tool = markUi.tool === tool && tool !== "select" ? "select" : tool;
  if (markUi.tool !== "select") {
    selectMark(null);
    setToolTray(true);
    window.getSelection()?.removeAllRanges();
  }
  syncMarkUi();
}

function setInk(ink) {
  if (!INKS.includes(ink)) return;
  markUi.ink = ink;
  const selected = markUi.marks.find((m) => m.id === markUi.selectedId);
  if (selected) {
    selected.ink = ink;
    saveMarks();
    paintAllUserPages();
  }
  syncMarkUi();
}

function selectMark(id) {
  markUi.selectedId = id || null;
  if (id) {
    pdfUi.activeClaim = null;
    if (readerActive) {
      claimsEl.querySelectorAll(".claim.is-active").forEach((n) => n.classList.remove("is-active"));
    }
    document.querySelectorAll(".hl.is-active").forEach((n) => {
      n.classList.remove("is-active");
    });
    const selected = markUi.marks.find((m) => m.id === id);
    if (selected) markUi.ink = selected.ink;
  }
  paintAllUserPages();
  syncMarkUi();
}

function deleteSelectedMark() {
  if (!markUi.selectedId) return;
  markUi.marks = markUi.marks.filter((m) => m.id !== markUi.selectedId);
  markUi.selectedId = null;
  saveMarks();
  paintAllUserPages();
  syncMarkUi();
}

function localPoint(wrap, clientX, clientY) {
  return clientToLocal(wrap.getBoundingClientRect(), wrap.offsetWidth, wrap.offsetHeight, clientX, clientY);
}

function offsetAtPoint(data, x, y, maxDist = 28) {
  let best = null;
  let bestDist = Infinity;
  for (const r of data.ranges) {
    if (r.start === r.end) continue;
    const run = itemRun(r.item, data.viewport);
    const rect = run.rect;
    if (rect.width < 1 || rect.height < 1) continue;
    const dx = x < rect.left ? rect.left - x : x > rect.left + rect.width ? x - (rect.left + rect.width) : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.top + rect.height ? y - (rect.top + rect.height) : 0;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = r.start + Math.round(runT(run.axis, rect, x, y) * (r.end - r.start));
    }
  }
  if (best == null || bestDist > maxDist) return null;
  return best;
}

function runT(axis, rect, x, y) {
  if (axis === "y") return Math.min(1, Math.max(0, (y - rect.top) / rect.height));
  if (axis === "x-reverse") return Math.min(1, Math.max(0, (rect.left + rect.width - x) / rect.width));
  if (axis === "y-reverse") return Math.min(1, Math.max(0, (rect.top + rect.height - y) / rect.height));
  return Math.min(1, Math.max(0, (x - rect.left) / rect.width));
}

function spanRects(data, start, end) {
  const rects = [];
  for (const r of data.ranges) {
    if (r.end <= start || r.start >= end || r.start === r.end) continue;
    const run = itemRun(r.item, data.viewport);
    const rect = clipRangeRect(run.rect, r.start, r.end, start, end, run.axis);
    if (rect) rects.push({ ...rect, upX: run.upX, upY: run.upY, axis: run.axis });
  }
  return rects;
}

function markCssBox(data, mark) {
  return annotBox(data.viewport, [mark.x1, mark.y1, mark.x2, mark.y2]);
}

function markHitRects(data, mark) {
  if (mark.type === "box") return [markCssBox(data, mark)];
  return spanRects(data, mark.start, mark.end);
}

function pointInRect(x, y, rect, pad = 0) {
  return (
    x >= rect.left - pad &&
    x <= rect.left + rect.width + pad &&
    y >= rect.top - pad &&
    y <= rect.top + rect.height + pad
  );
}

function hitTestMark(n, x, y) {
  const data = pdfUi.pageData.get(n);
  if (!data) return null;
  for (let i = markUi.marks.length - 1; i >= 0; i--) {
    const mark = markUi.marks[i];
    if (mark.page !== n) continue;
    const pad = mark.type === "underline" ? 6 : 1;
    if (markHitRects(data, mark).some((rect) => pointInRect(x, y, rect, pad))) return mark;
  }
  return null;
}

function placeMarkEl(el, rect, mark, preview) {
  const box =
    mark.type === "underline" ? underlineMarkRect(rect, { upX: rect.upX, upY: rect.upY }) : rect;
  el.className = `user-mark ${mark.type === "box" ? "user-box" : mark.type === "underline" ? "user-ul" : "user-hl"}`;
  if (mark.id === markUi.selectedId) el.classList.add("is-selected");
  if (preview) el.classList.add("is-preview");
  el.dataset.markId = mark.id || "";
  el.dataset.ink = mark.ink;
  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
}

function appendUserMark(data, mark, preview = false) {
  if (mark.type === "box") {
    const rect = markCssBox(data, mark);
    if (rect.width < 1 || rect.height < 1) return;
    const div = document.createElement("div");
    placeMarkEl(div, rect, mark, preview);
    data.userLayer.appendChild(div);
    return;
  }
  for (const rect of spanRects(data, mark.start, mark.end)) {
    const div = document.createElement("div");
    placeMarkEl(div, rect, mark, preview);
    data.userLayer.appendChild(div);
  }
}

function appendHandle(layer, x, y, attrs) {
  const h = document.createElement("div");
  h.className = "mark-handle";
  for (const [k, v] of Object.entries(attrs)) h.dataset[k] = v;
  const drag = markUi.drag;
  if (
    drag?.kind === "handle" &&
    ((attrs.edge && drag.edge === attrs.edge) || (attrs.corner && drag.corner === attrs.corner))
  ) {
    h.classList.add("is-drag");
  }
  h.style.left = `${x}px`;
  h.style.top = `${y}px`;
  layer.appendChild(h);
}

function handlePoint(rect, mark, edge) {
  const box = mark.type === "underline" ? underlineMarkRect(rect, { upX: rect.upX, upY: rect.upY }) : rect;
  const axis = rect.axis || (box.width >= box.height ? "x" : "y");
  const start = edge === "start";
  if (axis === "x") {
    const y = box.top + box.height / 2;
    return start ? [box.left, y] : [box.left + box.width, y];
  }
  if (axis === "x-reverse") {
    const y = box.top + box.height / 2;
    return start ? [box.left + box.width, y] : [box.left, y];
  }
  if (axis === "y") {
    const x = box.left + box.width / 2;
    return start ? [x, box.top] : [x, box.top + box.height];
  }
  const x = box.left + box.width / 2;
  return start ? [x, box.top + box.height] : [x, box.top];
}

function appendHandles(data, mark) {
  if (mark.type === "box") {
    const r = markCssBox(data, mark);
    const corners = {
      nw: [r.left, r.top],
      ne: [r.left + r.width, r.top],
      sw: [r.left, r.top + r.height],
      se: [r.left + r.width, r.top + r.height],
    };
    for (const [corner, [x, y]] of Object.entries(corners)) {
      appendHandle(data.handleLayer, x, y, { corner });
    }
    return;
  }
  const rects = spanRects(data, mark.start, mark.end);
  if (!rects.length) return;
  const [sx, sy] = handlePoint(rects[0], mark, "start");
  const [ex, ey] = handlePoint(rects[rects.length - 1], mark, "end");
  appendHandle(data.handleLayer, sx, sy, { edge: "start" });
  appendHandle(data.handleLayer, ex, ey, { edge: "end" });
}

function paintUserPage(data) {
  if (!data?.userLayer) return;
  data.userLayer.replaceChildren();
  data.handleLayer.replaceChildren();
  const n = Number(data.wrap.dataset.page);
  for (const mark of markUi.marks) {
    if (mark.page !== n) continue;
    appendUserMark(data, mark);
  }
  if (markUi.drag?.preview && markUi.drag.page === n) {
    appendUserMark(data, markUi.drag.preview, true);
  }
  const selected = markUi.marks.find((m) => m.id === markUi.selectedId && m.page === n);
  if (selected && (!markUi.drag || markUi.drag.kind === "handle" || markUi.drag.kind === "move")) {
    appendHandles(data, selected);
  }
}

function paintAllUserPages() {
  for (const data of pdfUi.pageData.values()) paintUserPage(data);
}

function onMarkPointerDown(e, n) {
  if (e.button !== 0 || markUi.drag) return;
  const data = pdfUi.pageData.get(n);
  if (!data) return;
  const handle = e.target.closest(".mark-handle");
  if (handle) {
    e.preventDefault();
    e.stopPropagation();
    beginHandleDrag(n, handle, e);
    return;
  }
  if (markUi.tool !== "select") {
    e.preventDefault();
    e.stopPropagation();
    beginDraw(n, e);
    return;
  }
  const userEl = e.target.closest(".user-mark");
  if (userEl) {
    e.preventDefault();
    e.stopPropagation();
    const mark = markUi.marks.find((m) => m.id === userEl.dataset.markId && m.page === n);
    if (mark?.type === "box") {
      beginMove(n, mark, e);
      return;
    }
    const { x, y } = localPoint(data.wrap, e.clientX, e.clientY);
    markUi.drag = {
      kind: "click",
      page: n,
      id: userEl.dataset.markId,
      x,
      y,
      moved: false,
    };
    return;
  }
  if (e.target.closest(".textLayer")) {
    selectMark(null);
    return;
  }
  if (e.target.tagName === "CANVAS") selectMark(null);
}

function beginDraw(n, e) {
  const data = pdfUi.pageData.get(n);
  const { x, y } = localPoint(data.wrap, e.clientX, e.clientY);
  markUi.selectedId = null;
  if (markUi.tool === "box") {
    const pdf = data.viewport.convertToPdfPoint(x, y);
    markUi.drag = {
      kind: "box",
      page: n,
      x0: pdf[0],
      y0: pdf[1],
      preview: null,
    };
  } else {
    const start = offsetAtPoint(data, x, y);
    if (start == null) return;
    markUi.drag = {
      kind: "text",
      type: markUi.tool,
      page: n,
      start,
      preview: null,
    };
  }
  try {
    data.wrap.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  paintUserPage(data);
}

function beginMove(n, mark, e) {
  const data = pdfUi.pageData.get(n);
  const { x, y } = localPoint(data.wrap, e.clientX, e.clientY);
  const wasSelected = markUi.selectedId === mark.id;
  markUi.selectedId = mark.id;
  markUi.drag = {
    kind: "move",
    page: n,
    markId: mark.id,
    x0: x,
    y0: y,
    moved: false,
    wasSelected,
    snapshot: { ...mark },
  };
  try {
    data.wrap.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  paintUserPage(data);
}

function beginHandleDrag(n, handle, e) {
  const mark = markUi.marks.find((m) => m.id === markUi.selectedId && m.page === n);
  if (!mark) return;
  markUi.drag = {
    kind: "handle",
    page: n,
    markId: mark.id,
    edge: handle.dataset.edge || "",
    corner: handle.dataset.corner || "",
    snapshot: { ...mark },
  };
  try {
    pdfUi.pageData.get(n).wrap.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  paintUserPage(pdfUi.pageData.get(n));
}

function onMarkPointerMove(e) {
  if (!markUi.drag) return;
  const data = pdfUi.pageData.get(markUi.drag.page);
  if (!data) return;
  const { x, y } = localPoint(data.wrap, e.clientX, e.clientY);
  if (markUi.drag.kind === "click") {
    if (Math.hypot(x - markUi.drag.x, y - markUi.drag.y) > 4) markUi.drag.moved = true;
    return;
  }
  e.preventDefault();
  if (markUi.drag.kind === "box") {
    const pdf = data.viewport.convertToPdfPoint(x, y);
    const box = boxFromPoints(markUi.drag.x0, markUi.drag.y0, pdf[0], pdf[1]);
    markUi.drag.preview = box
      ? { id: "preview", type: "box", page: markUi.drag.page, ink: markUi.ink, ...box }
      : null;
  } else if (markUi.drag.kind === "text") {
    const end = offsetAtPoint(data, x, y, 48);
    const span = end == null ? null : normalizeSpan(markUi.drag.start, end);
    markUi.drag.preview = span
      ? { id: "preview", type: markUi.drag.type, page: markUi.drag.page, ink: markUi.ink, ...span }
      : null;
  } else if (markUi.drag.kind === "handle") {
    applyHandleMove(data, markUi.drag, x, y);
  } else if (markUi.drag.kind === "move") {
    applyMove(data, markUi.drag, x, y);
  }
  paintUserPage(data);
}

function applyHandleMove(data, drag, x, y) {
  const mark = markUi.marks.find((m) => m.id === drag.markId);
  if (!mark) return;
  if (drag.edge) {
    const off = offsetAtPoint(data, x, y, 48);
    if (off == null) return;
    const anchor = drag.edge === "start" ? drag.snapshot.end : drag.snapshot.start;
    const span = normalizeSpan(anchor, off);
    if (span) {
      mark.start = span.start;
      mark.end = span.end;
    }
    return;
  }
  if (!drag.corner) return;
  const css = markCssBox(data, drag.snapshot);
  let left = css.left;
  let top = css.top;
  let right = css.left + css.width;
  let bottom = css.top + css.height;
  if (drag.corner.includes("n")) top = y;
  if (drag.corner.includes("s")) bottom = y;
  if (drag.corner.includes("w")) left = x;
  if (drag.corner.includes("e")) right = x;
  const p1 = data.viewport.convertToPdfPoint(left, top);
  const p2 = data.viewport.convertToPdfPoint(right, bottom);
  const box = boxFromPoints(p1[0], p1[1], p2[0], p2[1]);
  if (box) Object.assign(mark, box);
}

function applyMove(data, drag, x, y) {
  const mark = markUi.marks.find((m) => m.id === drag.markId);
  if (!mark || mark.type !== "box") return;
  const dx = x - drag.x0;
  const dy = y - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
  if (!drag.moved) return;
  const next = shiftCssBox(markCssBox(data, drag.snapshot), dx, dy, {
    width: data.wrap.offsetWidth,
    height: data.wrap.offsetHeight,
  });
  const p1 = data.viewport.convertToPdfPoint(next.left, next.top);
  const p2 = data.viewport.convertToPdfPoint(next.left + next.width, next.top + next.height);
  const box = boxFromPoints(p1[0], p1[1], p2[0], p2[1]);
  if (box) Object.assign(mark, box);
}

function onMarkPointerUp() {
  const drag = markUi.drag;
  if (!drag) return;
  markUi.drag = null;
  if (drag.kind === "click") {
    if (!drag.moved && drag.id) {
      if (markUi.selectedId === drag.id) {
        const mark = markUi.marks.find((m) => m.id === drag.id);
        if (mark) {
          mark.ink = cycleInk(mark.ink);
          markUi.ink = mark.ink;
          saveMarks();
        }
      }
      selectMark(drag.id);
    }
    paintAllUserPages();
    syncMarkUi();
    return;
  }
  if (drag.kind === "handle" || drag.kind === "move") {
    const mark = markUi.marks.find((m) => m.id === drag.markId);
    if (drag.kind === "move" && !drag.moved) {
      if (drag.wasSelected && mark) {
        mark.ink = cycleInk(mark.ink);
        markUi.ink = mark.ink;
        saveMarks();
      }
      selectMark(drag.markId);
      paintAllUserPages();
      syncMarkUi();
      return;
    }
    if (mark && mark.type !== "box") {
      const span = normalizeSpan(mark.start, mark.end);
      if (!span) Object.assign(mark, drag.snapshot);
    }
    saveMarks();
    paintAllUserPages();
    return;
  }
  if (drag.preview) {
    const { preview } = drag;
    const mark = { ...preview, id: newMarkId() };
    markUi.marks.push(mark);
    saveMarks();
    selectMark(mark.id);
    return;
  }
  paintAllUserPages();
}

function cancelDrag() {
  const drag = markUi.drag;
  markUi.drag = null;
  if (drag?.kind === "handle" || drag?.kind === "move") {
    const mark = markUi.marks.find((m) => m.id === drag.markId);
    if (mark) Object.assign(mark, drag.snapshot);
  }
  paintAllUserPages();
}

function locateTextSpan(node) {
  let el = node;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  return el?.closest?.(".textLayer span") || null;
}

function pageFromNode(node) {
  let el = node;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const n = Number(el?.closest?.(".pdf-page")?.dataset?.page);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function hideSelMenu() {
  const menu = document.getElementById("sel-menu");
  if (!menu) return;
  menu.hidden = true;
  menu.innerHTML = "";
  selUi.quote = null;
  selUi.range = null;
  selUi.mark = null;
}

function placeSelMenu(menu, x, y) {
  menu.style.left = "0px";
  menu.style.top = "0px";
  const pos = clampMenuPos(x, y, menu.offsetWidth, menu.offsetHeight, window.innerWidth, window.innerHeight);
  menu.style.left = `${pos.left}px`;
  menu.style.top = `${pos.top}px`;
  return pos;
}

function selectedMarkAtPoint(clientX, clientY) {
  const mark = markUi.marks.find((m) => m.id === markUi.selectedId);
  if (!mark) return null;
  const data = pdfUi.pageData.get(mark.page);
  if (!data?.wrap) return null;
  const bounds = data.wrap.getBoundingClientRect();
  if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) {
    return null;
  }
  const { x, y } = localPoint(data.wrap, clientX, clientY);
  const pad = mark.type === "underline" ? 6 : 1;
  if (!markHitRects(data, mark).some((rect) => pointInRect(x, y, rect, pad))) return null;
  return mark;
}

function quoteAtActiveClaim(clientX, clientY, root = document) {
  const id = pdfUi.activeClaim;
  if (!id || !root?.querySelectorAll) return null;
  const nodes = root.querySelectorAll(
    `.hl.is-active[data-claim="${cssEscape(id)}"], mark.crux-quote.is-active[data-claim="${cssEscape(id)}"]`
  );
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
    const page = pageFromNode(el);
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return quoteFromMark(haystackForMark({ page }), { type: "highlight", page, start, end });
    }
    return quoteFromSelection(el.textContent, page);
  }
  return null;
}

function haystackForMark(mark) {
  const data = pdfUi.pageData.get(mark.page);
  if (data?.haystack) return data.haystack;
  return pdfUi.textCache.get(mark.page) || "";
}

function showSelMenu(e, kind, ox, oy, opts = {}) {
  const menu = document.getElementById("sel-menu");
  if (!menu) return false;
  e.preventDefault();
  e.stopPropagation();
  const actions = menuActions(kind, opts);
  menu.hidden = false;
  menu.innerHTML = actions
    .map((row) => `<button type="button" role="menuitem" data-act="${escapeAttr(row.id)}">${escapeHtml(row.label)}</button>`)
    .join("");
  menu.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => onSelMenuAct(btn.dataset.act));
  });
  selUi.pos = placeSelMenu(menu, e.clientX + ox, e.clientY + oy);
  return true;
}

function citationCount(quote) {
  if (!pdfUi.pdf || !quote?.text) return 0;
  return parseCitations(quote.text).length;
}

function openSelMenu(e, sel, kind, ox = 0, oy = 0) {
  const doc = e.target?.ownerDocument || document;
  const selected = kind === "web" ? null : selectedMarkAtPoint(e.clientX + ox, e.clientY + oy);
  const claimQuote = quoteAtActiveClaim(e.clientX, e.clientY, doc);
  const page = sel?.rangeCount ? pageFromNode(sel.getRangeAt(0).commonAncestorContainer) : null;
  const native = quoteFromSelection(sel?.toString() || "", page);
  const action = rightClickAction({
    selectedType: selected?.type || (claimQuote ? "claim" : null),
    onSelected: Boolean(selected || claimQuote),
    hasNative: Boolean(native),
  });
  if (action === "box") {
    selUi.mark = selected;
    selUi.quote = null;
    selUi.range = null;
    return showSelMenu(e, "box", ox, oy);
  }
  if (action === "mark") {
    const quote = selected
      ? quoteFromMark(haystackForMark(selected), selected)
      : claimQuote;
    if (!quote) return false;
    selUi.quote = quote;
    selUi.range = null;
    selUi.mark = selected;
    return showSelMenu(e, "mark", ox, oy, { citations: citationCount(quote) });
  }
  if (action === "native") {
    selUi.quote = native;
    selUi.range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    selUi.mark = null;
    return showSelMenu(e, kind === "web" || !native.page ? "web" : "pdf", ox, oy, {
      citations: citationCount(native),
    });
  }
  return false;
}

async function onSelMenuAct(act) {
  const quote = selUi.quote;
  const range = selUi.range;
  const mark = selUi.mark;
  const pos = selUi.pos;
  if (act === "save-image" || act === "copy-image" || act === "attach-image") {
    try {
      await onBoxImageAct(act, mark);
    } finally {
      hideSelMenu();
    }
    return;
  }
  const anchor = portalAnchor(range, pos);
  hideSelMenu();
  if (!quote) return;
  if (act === "portal") {
    openCitationPortal(quote, pos, anchor);
    return;
  }
  if (act === "copy") {
    copyText(quote.text);
    return;
  }
  if (act === "attach") {
    pdfUi.rail?.attachQuote(quote);
    window.getSelection()?.removeAllRanges();
    well.querySelector("iframe")?.contentWindow?.getSelection()?.removeAllRanges();
    return;
  }
  if (act === "highlight" || act === "underline") {
    markFromSelection(act, quote, range);
  }
}

function showSelMenuNote(pos, text) {
  const menu = document.getElementById("sel-menu");
  if (!menu) return;
  menu.hidden = false;
  menu.innerHTML = `<span class="sel-menu-note">${escapeHtml(text)}</span>`;
  placeSelMenu(menu, pos?.left ?? 40, pos?.top ?? 40);
}

// Where the preview card anchors: the selection's own rect when there is
// one, else the right-click point.
function portalAnchor(range, pos) {
  const r = range?.getBoundingClientRect?.();
  if (r && (r.width > 0 || r.height > 0)) return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  const x = pos?.left ?? window.innerWidth / 2;
  const y = pos?.top ?? window.innerHeight / 2;
  return { left: x, right: x, top: y, bottom: y };
}

// The citing side of a citation portal, from the right-click menu: same
// pipeline as hovering a marker, anchored to the selection.
async function openCitationPortal(quote, pos, anchor) {
  showSelMenuNote(pos, "Finding cited paper…");
  let found = [];
  try {
    found = await resolveCitesHybrid(parseCitations(quote.text), quote.text);
  } catch {
    found = [];
  }
  hideSelMenu();
  if (!found.length) {
    offerGrab(anchor, citeEntryText(parseCitations(quote.text), quote.text), quote.text, null);
    return;
  }
  openPortalRow(found.slice(0, 4), quote.text, anchor);
}

// Citation markers → bibliography entries → catalog papers, instantly and
// offline. Cites the heuristic cannot place come back in `missed` so the
// model pass can be asked about exactly those.
async function resolveCites(cites) {
  if (!cites.length) return { found: [], missed: [] };
  const catalog = await loadCatalogOnce();
  if (portalUi.refs === undefined) portalUi.refs = referencesText(await allPageTexts());
  const refs = portalUi.refs;
  const found = [];
  const missed = [];
  const seen = new Set();
  for (const cite of cites) {
    const entry =
      cite.kind === "num"
        ? entryForNumeric(refs, cite.n)
        : entryForAuthorYear(refs, cite.author, cite.year) || `${cite.author} ${cite.year}`;
    const match = entry ? matchCatalog(entry, catalog.papers, { selfId: paper.paper_id }) : null;
    if (!match) {
      missed.push(cite);
      continue;
    }
    if (!seen.has(match.paper_id)) {
      seen.add(match.paper_id);
      found.push(match);
    }
  }
  return { found, missed };
}

// Bibliography resolution is local; ambiguous references remain unresolved.
async function resolveCitesHybrid(cites) {
  return (await resolveCites(cites)).found;
}

// --- hover zones: every citation marker opens its portals on dwell ---

async function paintAllCiteZones() {
  if (isEmbed || !pdfUi.pdf || paper.origin === "web") return;
  if (portalUi.refsStart === undefined) portalUi.refsStart = referencesStart(await allPageTexts());
  for (const data of pdfUi.pageData.values()) paintCiteZones(data);
}

// Zone spans depend only on the page text, which never changes — compute
// once, not on every zoom or resize repaint.
function zonesForPage(n, haystack) {
  if (!portalUi.zoneSpans) portalUi.zoneSpans = new Map();
  if (!portalUi.zoneSpans.has(n)) {
    const rs = portalUi.refsStart;
    let zones = rs && n > rs.page ? [] : citationSpans(haystack);
    if (rs && n === rs.page) zones = zones.filter((z) => z.end <= rs.offset);
    portalUi.zoneSpans.set(n, zones);
  }
  return portalUi.zoneSpans.get(n);
}

// Zones stop at the bibliography: the entries themselves read as one giant
// run of author-year citations and would light up whole pages.
function paintCiteZones(data) {
  if (!data.citeLayer) return;
  data.citeLayer.replaceChildren();
  const n = Number(data.wrap.dataset.page);
  const zones = n ? zonesForPage(n, data.haystack) : [];
  data.citeZones = zones;
  zones.forEach((zone, i) => {
    paintSpan(data.citeLayer, data.ranges, data.viewport, zone, "cite-zone", (div) => {
      div.dataset.zone = String(i);
    }, data.textLayer);
  });
  data.citeRects = [...data.citeLayer.children].map((el) => ({ el, zone: Number(el.dataset.zone), ...paintedRect(el) }));
  for (const link of data.wrap.querySelectorAll(".pdf-link")) {
    if (link.hostname === "crux.local" && link.pathname.startsWith("/claim/")) continue;
    const rect = paintedRect(link);
    const hits = data.citeRects.filter((hit) => hit.left < rect.right && hit.right > rect.left && hit.top < rect.bottom && hit.bottom > rect.top);
    link.classList.toggle("citation-link", Boolean(hits.length));
    for (const hit of hits) hit.link = link;
  }
}

function paintedRect(el) {
  const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
  return { left, top, right: left + parseFloat(el.style.width), bottom: top + parseFloat(el.style.height) };
}

// Hover reads cached paint geometry; native text selection owns the pointer target.
function citationAtPoint(event) {
  if (event.target.closest(".pdf-link:not(.citation-link)")) return null;
  const n = Number(event.target.closest(".pdf-page")?.dataset.page);
  const data = pdfUi.pageData.get(n);
  if (!data?.citeRects?.length) return null;
  const rect = data.citeLayer.getBoundingClientRect();
  const x = (event.clientX - rect.left) * data.citeLayer.offsetWidth / rect.width;
  const y = (event.clientY - rect.top) * data.citeLayer.offsetHeight / rect.height;
  const hit = data.citeRects.find((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  return hit ? { data, n, hit } : null;
}

function onCiteMove(event) {
  if (event.buttons || markUi.tool !== "select" || markUi.drag || !window.getSelection()?.isCollapsed) {
    onCiteLeave();
    return;
  }
  const found = citationAtPoint(event);
  if (found?.hit === portalUi.hovered) return;
  onCiteLeave();
  if (!found) return;
  const { data, n, hit } = found;
  portalUi.hovered = hit;
  hit.el.classList.add("is-hovered");
  resolveZone(n, data.citeZones[hit.zone]).catch(() => {});
  const rect = hit.el.getBoundingClientRect();
  portalUi.hoverTimer = setTimeout(() => {
    openCitationHover(n, hit.zone, rect).catch(() => {});
  }, 180);
}

function onCiteLeave() {
  clearTimeout(portalUi.hoverTimer);
  portalUi.hoverGen++;
  portalUi.hovered?.el.classList.remove("is-hovered");
  portalUi.hovered = null;
}

async function openCitationHover(page, zoneIndex, rect) {
  const data = pdfUi.pageData.get(page);
  const zone = data?.citeZones?.[zoneIndex];
  if (!zone) return;
  const gen = ++portalUi.hoverGen;
  const anchor = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  const pending = resolveZone(page, zone);
  // give a cached answer one beat; otherwise open a skeleton bubble now and
  // fill it in when resolution lands
  let targets = await Promise.race([
    pending.catch(() => []),
    new Promise((r) => setTimeout(() => r(null), 90)),
  ]);
  if (portalUi.hoverGen !== gen) return;
  if (targets === null) {
    try {
      targets = await pending;
    } catch {
      targets = [];
    }
    if (portalUi.hoverGen !== gen) return;
  }
  const sentence = sentenceAround(data.haystack, zone.start, zone.end);
  if (!targets.length) {
    offerGrab(anchor, citeEntryText(zone.cites, sentence), sentence, `${page}:${zone.start}:${zone.end}`);
    return;
  }
  openPortalRow(targets.slice(0, 4), sentence, anchor);
}

// The best text we can hand the open-access search: the bibliography entry
// when one was found, else the citing sentence itself.
function citeEntryText(cites, sentence) {
  const refs = portalUi.refs || "";
  for (const c of cites || []) {
    const entry =
      c.kind === "num" ? entryForNumeric(refs, c.n) : entryForAuthorYear(refs, c.author, c.year);
    if (entry) return entry;
  }
  return sentence;
}

function offerGrab(anchor, entryText, sentence, zoneKeyStr) {
  host.citation(window, { entry: entryText, text: sentence, related: true, onRetrieved(row) {
    portalUi.catalog = null;
    if (zoneKeyStr) portalUi.zoneCache?.set(zoneKeyStr, Promise.resolve([row]));
  } }, anchor);
}

function resolveZone(page, zone) {
  if (!portalUi.zoneCache) portalUi.zoneCache = new Map();
  const key = `${page}:${zone.start}:${zone.end}`;
  if (!portalUi.zoneCache.has(key)) {
    portalUi.zoneCache.set(
      key,
      (async () => {
        const data = pdfUi.pageData.get(page);
        const sentence = data ? sentenceAround(data.haystack, zone.start, zone.end) : "";
        try {
          return await resolveCitesHybrid(zone.cites, sentence);
        } catch {
          return [];
        }
      })()
    );
  }
  return portalUi.zoneCache.get(key);
}

async function loadCatalogOnce() {
  if (!portalUi.catalog) {
    portalUi.catalog = fetch("/api/catalog")
      .then((r) => (r.ok ? r.json() : { papers: [] }))
      .catch(() => ({ papers: [] }));
  }
  return portalUi.catalog;
}

function openPortalRow(targets, contextText, anchor) {
  host.citation(window, { paper_id: targets[0].paper_id, text: contextText, related: true, candidates: targets }, anchor);
}

function cropMarkCanvas(mark) {
  const data = pdfUi.pageData.get(mark?.page);
  const canvas = data?.wrap.querySelector("canvas");
  if (!canvas || !mark) return null;
  const src = cropBoxSource(
    markCssBox(data, mark),
    data.wrap.offsetWidth,
    data.wrap.offsetHeight,
    canvas.width,
    canvas.height
  );
  if (!src) return null;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(src.sw));
  out.height = Math.max(1, Math.round(src.sh));
  out.getContext("2d").drawImage(canvas, src.sx, src.sy, src.sw, src.sh, 0, 0, out.width, out.height);
  return out;
}

function boxFileName(mark) {
  const id = String(paper.paper_id || "paper").replace(/[^\w.-]+/g, "_");
  return `${id}-p${mark.page}-box.png`;
}

async function onBoxImageAct(act, mark) {
  const data = pdfUi.pageData.get(mark?.page);
  if (data) await drawPage(data);
  const canvas = cropMarkCanvas(mark);
  if (!canvas) {
    showBanner("Could not capture that box.");
    return;
  }
  if (act === "save-image") {
    savePng(canvas, boxFileName(mark));
    return;
  }
  if (act === "copy-image") {
    try {
      await copyPng(canvas);
    } catch {
      showBanner("Could not copy that image.");
    }
    return;
  }
  pdfUi.rail?.attachQuote({
    type: "image",
    page: mark.page,
    data: canvas.toDataURL("image/png"),
    name: `p.${mark.page} box`,
    markId: mark.id,
  });
}

function savePng(canvas, name) {
  canvas.toBlob((blob) => {
    if (!blob) {
      showBanner("Could not save that image.");
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
}

async function copyPng(canvas) {
  const dataUrl = canvas.toDataURL("image/png");
  const blob = pngBlobFromDataUrl(dataUrl);
  if (!blob) throw new Error("empty");
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    const items = clipboardPngItems(blob);
    try {
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return;
    } catch {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return;
      } catch {
        /* native image clipboard denied — try a selected image */
      }
    }
  }
  if (!copyPngThroughSelection(dataUrl)) throw new Error("clipboard");
}

function copyPngThroughSelection(dataUrl) {
  const img = document.createElement("img");
  img.src = dataUrl;
  const holder = document.createElement("div");
  holder.contentEditable = "true";
  holder.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  holder.appendChild(img);
  document.body.appendChild(holder);
  const sel = window.getSelection();
  const prev = [];
  for (let i = 0; i < (sel?.rangeCount || 0); i++) prev.push(sel.getRangeAt(i).cloneRange());
  const range = document.createRange();
  range.selectNode(img);
  sel.removeAllRanges();
  sel.addRange(range);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  sel.removeAllRanges();
  for (const r of prev) sel.addRange(r);
  holder.remove();
  return ok;
}

function markFromSelection(type, quote, range) {
  const data = pdfUi.pageData.get(quote.page);
  if (!data) {
    showBanner("Could not mark that selection.");
    return;
  }
  let span = null;
  if (range) {
    const pairs = zipTextSpans(data.textLayer, data.ranges);
    if (pairs) span = spanFromDomRange(range, pairs, locateTextSpan);
  }
  if (!span) span = findQuote(data.haystack, quote.text);
  if (!span) {
    showBanner("Could not mark that selection.");
    return;
  }
  markUi.marks.push({
    id: newMarkId(),
    type,
    page: quote.page,
    ink: markUi.ink,
    start: span.start,
    end: span.end,
  });
  saveMarks();
  selectMark(markUi.marks[markUi.marks.length - 1].id);
  window.getSelection()?.removeAllRanges();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      showBanner("Could not copy that selection.");
    }
    ta.remove();
  }
}

function bindSelectionMenu() {
  const menu = document.getElementById("sel-menu");
  if (!menu) return;
  well.addEventListener("contextmenu", (e) => {
    if (!openSelMenu(e, window.getSelection(), paper.origin === "web" ? "web" : "pdf")) hideSelMenu();
  });
  well.addEventListener("scroll", hideSelMenu, { passive: true });
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!menu.hidden && !menu.contains(e.target)) hideSelMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      e.preventDefault();
      hideSelMenu();
    }
  });
  window.addEventListener("blur", hideSelMenu);
  window.addEventListener("resize", hideSelMenu);
}

function bindWebSelectionMenu(iframe) {
  const doc = iframe.contentDocument;
  if (!doc) return;
  doc.addEventListener("contextmenu", (e) => {
    const rect = iframe.getBoundingClientRect();
    openSelMenu(e, iframe.contentWindow.getSelection(), "web", rect.left, rect.top);
  });
}

function setToolTray(open) {
  host.setToolTray(open);
}

function shouldLiveFit() {
  return pdfUi.mode === "width" && !pdfUi.customScale && pdfUi.pdf;
}

function liveFitStack() {
  if (!shouldLiveFit()) return;
  const stack = well.querySelector(".pdf-stack");
  const page = stack?.querySelector(".pdf-page");
  if (!stack || !page) return;
  const avail = Math.max(120, well.clientWidth - 48);
  const base = page.offsetWidth;
  if (base < 8) return;
  const s = avail / base;
  // Bound both the native and scaled layout box to the available width.
  stack.style.width = `${Math.min(base, avail)}px`;
  stack.style.alignItems = "flex-start";
  stack.style.transformOrigin = "top left";
  stack.style.transform = `scale(${s})`;
  stack.style.marginBottom = `${stack.offsetHeight * (s - 1)}px`;
  const next = well.scrollHeight - well.clientHeight;
  if (next > 0 && pdfUi.fitFrac != null) well.scrollTop = pdfUi.fitFrac * next;
  zoomInput.value = `${Math.round(pdfUi.scale * s * 100)}%`;
}

function clearStackFit() {
  const stack = well.querySelector(".pdf-stack");
  if (!stack) return;
  stack.style.width = "";
  stack.style.alignItems = "";
  stack.style.transformOrigin = "";
  stack.style.transform = "";
  stack.style.marginBottom = "";
}

function bindFitMenu() {
  const labels = { width: "Width", height: "Height", auto: "Page", single: "Single", double: "Spread" };
  const toggle = document.getElementById("pdf-fit-toggle");
  const list = document.getElementById("pdf-fit-list");
  const label = document.getElementById("pdf-fit-label");
  const menu = document.getElementById("fit-menu");
  function placeFit() {
    const pill = document.getElementById("pdf-toolbar");
    const pr = pill.getBoundingClientRect();
    const r = toggle.getBoundingClientRect();
    list.style.left = `${Math.round(r.left - pr.left + r.width / 2)}px`;
  }
  function closeFit() {
    list.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }
  function syncFit() {
    label.textContent = labels[pdfUi.mode] || "Width";
    list.querySelectorAll("[data-fit]").forEach((btn) => {
      const on = btn.dataset.fit === pdfUi.mode;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = list.hidden;
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) placeFit();
  });
  window.addEventListener("resize", () => {
    if (!list.hidden) placeFit();
  });
  list.querySelectorAll("[data-fit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pdfUi.mode = btn.dataset.fit;
      pdfUi.customScale = null;
      closeFit();
      syncFit();
      renderPdf();
    });
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && !list.contains(e.target)) closeFit();
  });
  const onEsc = (e) => {
    if (e.key === "Escape" && !list.hidden) {
      e.stopPropagation();
      closeFit();
      toggle.focus();
    }
  };
  toggle.addEventListener("keydown", onEsc);
  list.addEventListener("keydown", onEsc);
  syncFit();
}

function bindPdfToolbar() {
  window.addEventListener("pointermove", onMarkPointerMove);
  window.addEventListener("pointerup", onMarkPointerUp);
  window.addEventListener("pointercancel", onMarkPointerUp);
  bindScrollRail();
  const interruptGoto = () => {
    if (!pdfUi.gotoAnim) return;
    stopGoto({ sync: true });
  };
  well.addEventListener("wheel", interruptGoto, { passive: true });
  well.addEventListener("touchstart", interruptGoto, { passive: true });
  well.addEventListener("pointerdown", interruptGoto);
  document.getElementById("pdf-prev").onclick = () => goToPage(pdfUi.page - pageStep());
  document.getElementById("pdf-next").onclick = () => goToPage(pdfUi.page + pageStep());
  // only an edited field jumps: a book's labels need not map back to one page
  let pageEdited = false;
  pageInput.addEventListener("focus", () => {
    pdfUi.pageFieldFocused = true;
    pageEdited = false;
  });
  pageInput.addEventListener("input", () => {
    pageEdited = true;
  });
  pageInput.addEventListener("blur", () => {
    pdfUi.pageFieldFocused = false;
    if (pageEdited) goToPage(pageFromInput(pageInput.value));
    pageEdited = false;
  });
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (pageEdited) goToPage(pageFromInput(pageInput.value));
      pageEdited = false;
      pageInput.blur();
    }
  });
  // a click during a re-render builds on the zoom it is heading to, not the one still on screen
  const zoomBase = () => (pdfUi.rendering && pdfUi.customScale ? pdfUi.customScale : displayedScale());
  document.getElementById("pdf-zoom-out").onclick = () => applyZoom(zoomBase() / 1.15);
  document.getElementById("pdf-zoom-in").onclick = () => applyZoom(zoomBase() * 1.15);
  zoomInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const n = parseFloat(String(zoomInput.value).replace("%", ""));
    if (Number.isFinite(n) && n > 0) applyZoom(n / 100);
  });
  bindFitMenu();
  document.getElementById("pdf-rotate").onclick = () => {
    pdfUi.rotation = (pdfUi.rotation + 90) % 360;
    renderPdf();
  };
  document.getElementById("pdf-find-toggle").onclick = () => {
    const slot = document.getElementById("find-slot");
    setFindOpen(!slot.classList.contains("is-open"));
  };
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      findInput.value = "";
      runFind("");
      setFindOpen(false);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = findInput.value;
    if (q.trim() === pdfUi.findQuery && pdfUi.findHits.length) {
      showFindHit(pdfUi.findIndex + (e.shiftKey ? -1 : 1));
    } else {
      runFind(q);
    }
  });
  document.getElementById("pdf-find-next").onclick = () => {
    if (findInput.value.trim() !== pdfUi.findQuery) runFind(findInput.value);
    else showFindHit(pdfUi.findIndex + 1);
  };
  document.getElementById("pdf-find-prev").onclick = () => {
    if (findInput.value.trim() !== pdfUi.findQuery) runFind(findInput.value);
    else showFindHit(pdfUi.findIndex - 1);
  };
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !pdfControls.hidden) {
      e.preventDefault();
      setFindOpen(true);
    }
    if (e.key === "F3" && pdfUi.findHits.length) {
      e.preventDefault();
      showFindHit(pdfUi.findIndex + (e.shiftKey ? -1 : 1));
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (!typing && (e.key === "Delete" || e.key === "Backspace") && markUi.selectedId) {
      e.preventDefault();
      deleteSelectedMark();
      return;
    }
    if (!typing && e.key === "Escape") {
      e.preventDefault();
      const fitList = document.getElementById("pdf-fit-list");
      if (fitList && !fitList.hidden) {
        fitList.hidden = true;
        document.getElementById("pdf-fit-toggle").setAttribute("aria-expanded", "false");
        return;
      }
      const findSlot = document.getElementById("find-slot");
      if (findSlot && findSlot.classList.contains("is-open")) {
        findInput.value = "";
        runFind("");
        setFindOpen(false);
        return;
      }
      if (pdfUi.portalHits) {
        clearPortalHits();
        return;
      }
      if (markUi.drag) cancelDrag();
      else if (markUi.selectedId) selectMark(null);
      else if (markUi.tool !== "select") setTool("select");
      else if (markDock.classList.contains("is-open")) setToolTray(false);
      return;
    }
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      goToPage(pdfUi.page + (e.key === "ArrowUp" ? -pageStep() : pageStep()));
    }
  });
  new ResizeObserver((entries) => {
    if (!pdfUi.claimsReady || pdfUi.ignoreResize || pdfUi.rendering || pdfUi.customScale) return;
    if (pdfUi.railAnim || pdfUi.railResize) {
      liveFitStack();
      scheduleScrollRail();
      return;
    }
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    const last = pdfUi.lastWell;
    if (last && Math.abs(last.w - rect.width) < 3 && Math.abs(last.h - rect.height) < 3) {
      scheduleScrollRail();
      return;
    }
    pdfUi.lastWell = { w: rect.width, h: rect.height };
    clearTimeout(pdfUi.resizeTimer);
    if (shouldLiveFit()) {
      const anchor = fractionalPage();
      liveFitStack();
      scrollToFractional(anchor);
      scheduleScrollRail();
    } else {
      pdfUi.resizeTimer = setTimeout(() => renderPdf(), 200);
    }
  }).observe(well);
}

function itemRun(item, viewport) {
  const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const wEm = item.height ? item.width / item.height : 0;
  const corners = [
    [m[4], m[5]],
    [m[4] + m[0] * wEm, m[5] + m[1] * wEm],
    [m[4] + m[2], m[5] + m[3]],
    [m[4] + m[0] * wEm + m[2], m[5] + m[1] * wEm + m[3]],
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    rect: { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top },
    axis: runAxis(m[0] * wEm, m[1] * wEm),
    upX: m[2],
    upY: m[3],
  };
}

async function openWeb(paper) {
  document.getElementById("scroll-rail").hidden = true;
  statusEl.textContent = "Fetching live page";
  const iframe = document.createElement("iframe");
  iframe.title = paper.title;
  iframe.src = `/proxy/${encodeURIComponent(paper.paper_id)}`;
  well.innerHTML = "";
  well.appendChild(iframe);
  iframe.addEventListener("load", () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc || !doc.body) throw new Error("empty");
      paintWeb(doc, paper);
      bindWebSelectionMenu(iframe);
      renderClaimList();
      tallyMissed();
      statusEl.textContent = paper.source_url;
        } catch (err) {
      showBanner("Could not paint highlights on this live page.");
      statusEl.textContent = "Live page blocked painting";
    }
  });
}

function paintWeb(doc, paper) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let haystack = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue) continue;
    const start = haystack.length;
    haystack += node.nodeValue;
    nodes.push({ start, end: haystack.length, node });
  }
  const jobs = [];
  for (const claim of paper.claims || []) {
    for (const q of claimTargets(claim)) {
      const span = findQuote(haystack, q.text || "");
      if (!span) continue;
      recordHit(claim.id);
      jobs.push({ claim, span });
    }
  }
  jobs.sort((a, b) => b.span.start - a.span.start);
  let floor = Infinity; // wrapping a span that overlaps a wrapped one throws; it still counts as found
  for (const { claim, span } of jobs) {
    if (span.end > floor) continue;
    wrapWeb(doc, nodes, span.start, span.end, claim);
    floor = span.start;
  }
}

function wrapWeb(doc, nodes, start, end, claim) {
  let startNode;
  let startOff;
  let endNode;
  let endOff;
  for (const n of nodes) {
    if (start >= n.start && start < n.end) {
      startNode = n.node;
      startOff = start - n.start;
    }
    if (end > n.start && end <= n.end) {
      endNode = n.node;
      endOff = end - n.start;
    }
  }
  if (!startNode || !endNode) return;
  const range = doc.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  const mark = doc.createElement("mark");
  mark.className = "crux-quote";
  mark.dataset.claim = claim.id;
  mark.dataset.kind = claim.kind || "other";
  mark.addEventListener("click", () => activate(claim.id, "doc"));
  try {
    range.surroundContents(mark);
  } catch {
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return s.replace(/"/g, '\\"');
}
