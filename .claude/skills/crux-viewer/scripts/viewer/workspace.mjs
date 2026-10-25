import { bindRailPanes } from "./rail_panes.mjs";
import { sourcePreview } from "./passage_preview.mjs";
import { clampRailWidth } from "./rail_layout.mjs";
import { bindExtraction } from "./extraction.mjs";

const $ = (id) => document.getElementById(id);
const groups = { left: { frame: null }, right: { frame: null } };
const documents = new Map();
const viewStates = new Map();
const markStores = new Map();
let active = "left";
let tool = "select";
let ink = "yellow";
let previewGeneration = 0;
let catalog = [];
let railWidth = 300;
const panes = bindRailPanes({ paperId: "", chatId: "_workspace", claimCount: 0,
  onCitation: showCitation, getContext: () => ({ sources: readers().map(({ api }) => ({ paper_id: api.paper.paper_id, page: api.page })), active_paper_id: groups[active].id }) });
const extraction = bindExtraction({ onComplete: refreshClaims });

function refreshClaims(id) {
  for (const [side, group] of Object.entries(groups)) {
    if (group.id !== id || !group.frame) continue;
    const api = group.frame.contentWindow.cruxReader;
    if (api) viewStates.set(`${side}:${id}`, api.snapshot());
    group.frame.contentWindow.location.reload();
  }
}

function readers() {
  return Object.entries(groups).flatMap(([side, group]) => {
    const api = group.frame?.contentWindow?.cruxReader;
    return api ? [{ side, group, api }] : [];
  });
}

function groupFor(win) {
  return Object.entries(groups).find(([, group]) => group.frame?.contentWindow === win);
}

function focus(side) {
  active = side;
  extraction.setPaper(groups[side].id || "");
  for (const row of readers()) {
    row.api.setActive(row.side === side);
  }
  const api = groups[side].frame?.contentWindow?.cruxReader;
  if (api) {
    panes.setPaper(api.paper.paper_id);
    $("mark-dock").hidden = !api.pdf;
    $("tool-tray-toggle").title = `Markup · ${api.paper.title}`;
  }
  document.querySelectorAll(".reader-group").forEach((el) => el.classList.toggle("is-active", el.dataset.readerGroup === side));
  renderTabs();
}

function layout(change) {
  const current = readers();
  current.forEach(({ api }) => api.resizeStart());
  change();
  requestAnimationFrame(() => requestAnimationFrame(() => current.forEach(({ group, api }) => {
    if (group.frame?.isConnected && group.frame.contentWindow.cruxReader === api) api.resizeEnd();
  })));
}

function openPaper(id, side = active, source = null) {
  const group = groups[side];
  if (group.id === id && group.frame) {
    focus(side);
    if (source) {
      if (group.frame.contentWindow.cruxReader) group.frame.contentWindow.cruxReader.locate(source);
      else group.source = source;
    }
    return;
  }
  const paper = catalog.find((row) => row.paper_id === id);
  $("reader-empty").hidden = true;
  documents.set(id, paper?.title || id);
  const previous = group.frame?.contentWindow?.cruxReader;
  if (previous) viewStates.set(`${side}:${group.id}`, previous.snapshot());
  layout(() => {
    const root = document.querySelector(`[data-reader-group="${side}"]`);
    root.hidden = false;
    group.frame?.remove();
    const frame = document.createElement("iframe");
    frame.id = `reader-${side}`;
    frame.title = paper?.title || id;
    // A new frame destroys the previous reader's listeners, observers and PDF worker.
    frame.src = `/reader/${encodeURIComponent(id)}`;
    Object.assign(group, { frame, id, source });
    root.append(frame);
    $("reader-groups").classList.toggle("is-split", Boolean(groups.right.frame));
    $("split-resizer").hidden = !groups.right.frame;
  });
  active = side;
  extraction.setPaper(id);
  renderTabs();
}

function closeRight() {
  const api = groups.right.frame?.contentWindow?.cruxReader;
  if (api) viewStates.set(`right:${groups.right.id}`, api.snapshot());
  layout(() => {
    groups.right.frame?.remove();
    groups.right = { frame: null };
    document.querySelector('[data-reader-group="right"]').hidden = true;
    $("reader-groups").classList.remove("is-split");
    $("split-resizer").hidden = true;
  });
  focus("left");
}

function renderTabs() {
  const split = $("split-right");
  split.classList.toggle("is-on", Boolean(groups.right.frame));
  split.setAttribute("aria-expanded", String(Boolean(groups.right.frame)));
  split.title = groups.right.frame ? "Close right reader" : "Open alongside";
  split.setAttribute("aria-label", split.title);
  for (const item of [...$("tabs").children]) {
    if (!documents.has(item.dataset.document)) item.remove();
  }
  for (const [id, title] of documents) {
    let button = document.getElementById(`doc-tab-${id}`);
    if (!button) {
      const item = document.createElement("div");
      item.className = "document-tab";
      item.dataset.document = id;
      button = document.createElement("button");
      button.type = "button";
      button.role = "tab";
      button.id = `doc-tab-${id}`;
      button.innerHTML = '<span class="tab-title"></span><span class="tab-side"></span>';
      button.onclick = (event) => openPaper(id, event.shiftKey ? "right" : active);
      button.onkeydown = (event) => {
        if (event.key === "Delete") { event.preventDefault(); closeDocument(id); return; }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const ids = [...documents.keys()];
        const index = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 :
          (ids.indexOf(id) + (event.key === "ArrowLeft" ? -1 : 1) + ids.length) % ids.length;
        openPaper(ids[index]);
        document.getElementById(`doc-tab-${ids[index]}`).focus();
      };
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      close.onclick = () => closeDocument(id);
      item.append(button, close);
      $("tabs").append(item);
    }
    const selected = groups[active].id === id;
    const sides = Object.entries(groups).filter(([, group]) => group.id === id).map(([side]) => side);
    button.querySelector(".tab-title").textContent = title;
    button.querySelector(".tab-side").textContent = groups.right.frame && sides.length ?
      (sides.length === 2 ? "Both" : sides[0] === "left" ? "Left" : "Right") : "";
    button.title = title;
    button.tabIndex = selected ? 0 : -1;
    button.setAttribute("aria-selected", String(selected));
    button.setAttribute("aria-controls", `reader-group-${selected ? active : sides[0] || active}`);
    button.parentElement.classList.toggle("is-selected", selected);
    const close = button.nextElementSibling;
    close.setAttribute("aria-label", `Close ${title}`);
    close.title = `Close ${title}`;
    close.tabIndex = selected ? 0 : -1;
  }
  for (const [side, group] of Object.entries(groups)) {
    if (group.id) $(`reader-group-${side}`).setAttribute("aria-labelledby", `doc-tab-${group.id}`);
    else $(`reader-group-${side}`).removeAttribute("aria-labelledby");
  }
  if (!$("library").hidden) renderLibrary();
}

function closeDocument(id) {
  documents.delete(id);
  viewStates.delete(`left:${id}`);
  viewStates.delete(`right:${id}`);
  if (groups.right.id === id) closeRight();
  if (groups.left.id === id) {
    layout(() => {
      groups.left.frame?.remove();
      groups.left = groups.right.frame ? groups.right : { frame: null };
      groups.right = { frame: null };
      if (groups.left.frame) {
        groups.left.frame.id = "reader-left";
        // Keep the surviving iframe mounted: reparenting reloads its PDF and state.
        const left = $("reader-group-left");
        const right = $("reader-group-right");
        left.id = "reader-group-right";
        left.dataset.readerGroup = "right";
        right.id = "reader-group-left";
        right.dataset.readerGroup = "left";
      }
      $("reader-group-right").hidden = true;
      $("reader-groups").classList.remove("is-split");
      $("split-resizer").hidden = true;
    });
    if (!groups.left.frame && documents.size) openPaper(documents.keys().next().value, "left");
  }
  focus(groups[active].frame ? active : "left");
  if (!documents.size) {
    $("reader-empty").hidden = false;
    $("mark-dock").hidden = true;
    $("claims").replaceChildren();
    $("meta").textContent = "";
    panes.setPaper("");
    toggleRail(true);
    if ($("library").hidden) $("library-toggle").click();
  } else {
    document.getElementById(`doc-tab-${groups[active].id}`)?.focus();
  }
}

function toggleRail(open = document.body.classList.contains("rail-off")) {
  if (open === !document.body.classList.contains("rail-off")) return;
  layout(() => {
    document.body.classList.toggle("rail-off", !open);
    $("rail-toggle").setAttribute("aria-expanded", String(open));
    $("rail-toggle").setAttribute("aria-label", open ? "Hide pane" : "Show pane");
    $("rail-toggle").title = open ? "Hide pane" : "Show pane";
  });
}

function syncTools(nextTool, nextInk) {
  tool = nextTool;
  ink = nextInk;
  for (const name of ["select", "highlight", "box", "underline"]) {
    const button = $(`tool-${name}`);
    button.classList.toggle("is-on", tool === name);
    button.setAttribute("aria-pressed", String(tool === name));
  }
  document.querySelectorAll("[data-ink]").forEach((el) => el.classList.toggle("is-on", el.dataset.ink === ink));
}

function setToolTray(open) {
  $("mark-dock").classList.toggle("is-open", open);
  $("tool-tray-toggle").setAttribute("aria-expanded", String(open));
}

// Each reader submits only its changed/deleted IDs. One queue per paper owns
// whole-list writes, so two views of the same paper cannot overwrite each other.
function saveMarks(win, before, after) {
  const match = groupFor(win);
  if (!match) return;
  const id = match[1].id;
  const store = markStores.get(id) || { marks: structuredClone(before), queue: Promise.resolve() };
  markStores.set(id, store);
  const previous = new Map(before.map((mark) => [mark.id, JSON.stringify(mark)]));
  const next = new Map(after.map((mark) => [mark.id, mark]));
  const merged = new Map(store.marks.map((mark) => [mark.id, mark]));
  for (const key of previous.keys()) if (!next.has(key)) merged.delete(key);
  for (const [key, mark] of next) if (previous.get(key) !== JSON.stringify(mark)) merged.set(key, structuredClone(mark));
  store.marks = [...merged.values()];
  for (const { api } of readers()) if (api.paper.paper_id === id) api.applyMarks(store.marks);
  const body = JSON.stringify({ v: 1, marks: store.marks });
  store.queue = store.queue.then(async () => {
    const response = await fetch(`/api/marks/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    if (!response.ok) throw new Error("Could not save marks. Make another edit to retry.");
  }).catch((error) => { $("status").textContent = error.message; $("status").className = "workspace-error"; });
}

function hidePreview() {
  previewGeneration++;
  $("source-preview").hidden = true;
}

function placePreview(card, rect) {
  const below = rect.bottom + 8;
  const top = below + card.offsetHeight <= innerHeight - 8 ? below : (rect.top ?? rect.bottom) - card.offsetHeight - 8;
  card.style.left = `${Math.max(8, Math.min(innerWidth - card.offsetWidth - 8, rect.left))}px`;
  card.style.top = `${Math.max(8, Math.min(innerHeight - card.offsetHeight - 8, top))}px`;
}

async function resolveSource(source) {
  if (!source.claim_id) return source;
  if (source.claim_id.startsWith("artifact:")) {
    const name = source.claim_id.slice(9);
    let artifact = catalog.find((row) => row.artifact_name === name);
    if (!artifact) {
      catalog = (await fetch("/api/catalog").then((response) => response.json())).papers;
      artifact = catalog.find((row) => row.artifact_name === name);
    }
    if (!artifact) throw new Error("Report not found in this run.");
    return { paper_id: artifact.paper_id };
  }
  const response = await fetch(`/api/claim/${encodeURIComponent(source.claim_id)}`);
  if (!response.ok) throw new Error("Source not found. Ask the session to supply a paper and passage.");
  const payload = await response.json();
  const claim = payload.claim || payload;
  const quote = claim.quotes?.[0];
  return { paper_id: claim.paper_id, page: quote?.page || quote?.locator?.page, text: quote?.text, claim_id: claim.claim_id || claim.id };
}

async function showCitation(raw, anchor, open = false) {
  const generation = ++previewGeneration;
  const card = $("source-preview");
  card.innerHTML = `<div class="source-body">
    <div class="source-head"><span class="source-location"></span>
      <button class="source-close" type="button" aria-label="Close source preview"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button>
    </div>
    <blockquote></blockquote>
    <p class="source-status" role="status"></p>
  </div>
  <div class="source-footer"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 2H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-5-5Zm0 0v5h5M7 10h6m-6 3h6"/></svg>
    <div class="source-identity"><span class="source-title"></span><span class="source-hint"></span></div>
  </div>`;
  card.hidden = false;
  const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  const body = card.querySelector(".source-body");
  const location = card.querySelector(".source-location");
  const quote = card.querySelector("blockquote");
  const note = card.querySelector(".source-status");
  const footer = card.querySelector(".source-footer");
  const title = card.querySelector(".source-title");
  const hint = card.querySelector(".source-hint");
  card.querySelector(".source-close").onclick = hidePreview;
  location.textContent = raw.related ? "Cited paper" : "Source passage";
  title.textContent = raw.entry || "Finding source…";
  placePreview(card, rect);
  try {
    if (raw.entry !== undefined) {
      hint.textContent = "Not in this library";
      const get = document.createElement("button");
      get.type = "button";
      get.className = "source-retrieve";
      get.textContent = "Get open copy";
      get.disabled = !raw.entry;
      note.textContent = raw.entry ? "Get an open copy to search the cited paper." : "Select a passage with a citation to find its source.";
      get.onclick = async () => {
        get.disabled = true;
        get.textContent = "Searching…";
        note.textContent = "Looking for an open-access PDF.";
        placePreview(card, rect);
        try {
          const response = await fetch("/api/grab", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry: raw.entry }),
          });
          if (!response.ok) throw new Error(response.status === 404 ? "No open copy found." : "Could not retrieve this paper.");
          const row = await response.json();
          if (!row.paper_id) throw new Error("No open copy found.");
          if (!catalog.some((paper) => paper.paper_id === row.paper_id)) catalog.push(row);
          raw.onRetrieved?.(row);
          renderLibrary();
          // A completed retrieval may update the library, never reopen a dismissed or replaced card.
          if (generation === previewGeneration) showCitation({ paper_id: row.paper_id, text: raw.text, related: true }, rect);
        } catch (error) {
          if (generation !== previewGeneration) return;
          note.textContent = error.message;
          get.textContent = "Try again";
          get.disabled = false;
          placePreview(card, rect);
        }
      };
      body.append(get);
      placePreview(card, rect);
      return;
    }
    const source = await resolveSource(raw);
    if (generation !== previewGeneration) return;
    if (!source.paper_id) throw new Error("This citation has no source paper.");
    if (open) { hidePreview(); openPaper(source.paper_id, "right", source); return; }
    title.textContent = source.candidates?.find((row) => row.paper_id === source.paper_id)?.title ||
      catalog.find((row) => row.paper_id === source.paper_id)?.title || source.paper_id;
    hint.textContent = "Open alongside";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-footer source-open";
    button.setAttribute("aria-label", `Open alongside: ${title.textContent}`);
    button.title = "Open source alongside";
    button.append(...footer.childNodes);
    button.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg>');
    let landing = source;
    button.onclick = () => { hidePreview(); openPaper(source.paper_id, "right", landing); };
    footer.replaceWith(button);
    if (source.candidates?.length > 1) {
      const index = source.candidates.findIndex((row) => row.paper_id === source.paper_id);
      const nav = document.createElement("div");
      nav.className = "source-nav";
      const count = document.createElement("span");
      count.textContent = `${index + 1} of ${source.candidates.length}`;
      nav.append(count);
      for (const [step, label] of [[-1, "Previous source"], [1, "Next source"]]) {
        const next = document.createElement("button");
        next.type = "button";
        next.setAttribute("aria-label", label);
        next.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${step < 0 ? "m10 4-4 4 4 4" : "m6 4 4 4-4 4"}"/></svg>`;
        next.onclick = () => {
          const row = source.candidates[(index + step + source.candidates.length) % source.candidates.length];
          showCitation({ ...source, paper_id: row.paper_id }, rect);
        };
        nav.append(next);
      }
      card.querySelector(".source-head").insertBefore(nav, card.querySelector(".source-close"));
    }
    placePreview(card, rect);
    if (!source.text) { note.textContent = "Open this document to read it."; return; }
    note.textContent = "Finding passage in the cited paper…";
    const existing = readers().find(({ api }) => api.paper.paper_id === source.paper_id);
    const preview = await sourcePreview(source, existing?.api.pdf, existing?.group.frame.contentDocument);
    if (generation !== previewGeneration) return;
    if (preview) {
      landing = { ...source, page: preview.page, text: preview.text };
      quote.textContent = preview.context || preview.text;
      location.textContent = `Page ${preview.page}${preview.exact ? "" : " · Related passage"}`;
      note.textContent = preview.exact ? "" : "Citation not verified.";
      const crop = document.createElement("details");
      crop.className = "source-crop";
      const summary = document.createElement("summary");
      summary.textContent = "View page crop";
      const image = new Image();
      image.src = preview.image;
      image.alt = `Source passage on page ${preview.page}`;
      image.width = preview.width;
      image.onload = () => { if (generation === previewGeneration) placePreview(card, rect); };
      crop.append(summary, image);
      crop.ontoggle = () => { if (generation === previewGeneration) placePreview(card, rect); };
      body.append(crop);
    } else {
      note.textContent = "Matching passage not found in the cited paper. Open it to inspect.";
    }
  } catch (error) {
    if (generation === previewGeneration) { title.textContent = "Source unavailable"; note.textContent = error.message; }
  }
  if (generation === previewGeneration) placePreview(card, rect);
}

/** Same-origin reader callbacks; only the two mounted reader windows are accepted. */
window.cruxWorkspace = {
  openLibrary() { toggleRail(true); setLibrary(true); },
  readerState(win) {
    const found = groupFor(win);
    return found ? viewStates.get(`${found[0]}:${found[1].id}`) : null;
  },
  ready(win) {
    const found = groupFor(win);
    if (!found) return;
    const [side, group] = found;
    const api = win.cruxReader;
    documents.set(group.id, api.paper.title);
    if (!markStores.has(group.id)) markStores.set(group.id, { marks: structuredClone(api.marks), queue: Promise.resolve() });
    api.applyMarks(markStores.get(group.id).marks);
    api.setTool(tool);
    api.setInk(ink);
    api.setActive(side === active);
    if (side === active) focus(side);
    if (group.source) { api.locate(group.source); group.source = null; }
    renderTabs();
  },
  focus(win) { const found = groupFor(win); if (found && active !== found[0]) focus(found[0]); },
  attachQuote(quote) { toggleRail(true); panes.attachQuote(quote); },
  showTab(tab) { toggleRail(true); panes.showTab(tab); },
  setMarkupAvailable(win, available) { if (groupFor(win)?.[0] === active) $("mark-dock").hidden = !available; },
  syncTools, setToolTray, saveMarks, hidePreview,
  citation(win, source, anchor, open) {
    const found = groupFor(win);
    if (!found) return;
    const rect = found[1].frame.getBoundingClientRect();
    showCitation(source, { left: rect.left + anchor.left, top: rect.top + (anchor.top ?? anchor.bottom), bottom: rect.top + anchor.bottom }, open);
  },
};

$("rail-toggle").onclick = () => toggleRail();
$("split-right").onclick = () => {
  if (groups.right.frame) closeRight();
  else if (groups[active].id) openPaper(groups[active].id, "right");
};
$("tool-tray-toggle").onclick = () => setToolTray(!$("mark-dock").classList.contains("is-open"));
for (const name of ["select", "highlight", "box", "underline"]) {
  $(`tool-${name}`).onclick = () => {
    const next = tool === name && name !== "select" ? "select" : name;
    for (const { api } of readers()) { api.setTool("select"); if (next !== "select") api.setTool(next); }
    syncTools(next, ink);
  };
}
document.querySelectorAll("[data-ink]").forEach((button) => {
  button.onclick = () => {
    for (const { api } of readers()) api.setInk(button.dataset.ink);
    syncTools(tool, button.dataset.ink);
  };
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#source-preview, .chat-citation")) hidePreview();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") hidePreview(); });
window.addEventListener("resize", hidePreview);

function renderLibrary() {
  const query = $("library-search").value.toLowerCase();
  $("library-papers").replaceChildren();
  for (const paper of catalog.filter((row) => row.title.toLowerCase().includes(query))) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/view/${encodeURIComponent(paper.paper_id)}`;
    link.textContent = paper.title;
    link.title = "Open source; Shift-click to open alongside";
    if (paper.paper_id === groups[active].id) link.setAttribute("aria-current", "page");
    link.onclick = (event) => { event.preventDefault(); openPaper(paper.paper_id, event.shiftKey ? "right" : active); };
    li.append(link);
    $("library-papers").append(li);
  }
}
$("library-search").oninput = renderLibrary;
async function setLibrary(open) {
  $("library").hidden = !open;
  $("library-toggle").setAttribute("aria-expanded", String(!$("library").hidden));
  if (!$("library").hidden) {
    $("library-search").focus();
    try {
      const response = await fetch("/api/catalog");
      if (!response.ok) throw new Error("Could not refresh Library. Reopen it to retry.");
      catalog = (await response.json()).papers;
      renderLibrary();
    } catch (error) {
      $("status").textContent = error.message;
      $("status").className = "workspace-error";
    }
  }
}
$("library-toggle").onclick = () => setLibrary($("library").hidden);

function resizeHandle(id, update) {
  const handle = $(id);
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    readers().forEach(({ api }) => api.resizeStart());
    document.body.classList.add("is-resizing");
    const move = (e) => update(e.clientX);
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing");
      readers().forEach(({ api }) => api.resizeEnd());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  });
  handle.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    layout(() => update(handle.getBoundingClientRect().left + (event.key === "ArrowLeft" ? -24 : 24)));
  });
}
resizeHandle("rail-resizer", (x) => {
  railWidth = clampRailWidth(Math.max(200, x), innerWidth);
  document.body.style.setProperty("--rail-open", `${railWidth}px`);
});
resizeHandle("split-resizer", (x) => {
  const rect = $("reader-groups").getBoundingClientRect();
  const percent = Math.max(25, Math.min(75, (x - rect.left) / rect.width * 100));
  $("reader-groups").style.setProperty("--split", `${percent}%`);
});

try {
  catalog = (await fetch("/api/catalog").then((response) => response.json())).papers;
  const hash = new URLSearchParams(location.hash.slice(1));
  const id = location.pathname.startsWith("/view/") ? decodeURIComponent(location.pathname.slice(6)) : hash.get("paper") || catalog[0]?.paper_id;
  if (id) {
    openPaper(id, "left");
    // Preserve links produced by CRUX claims and report anchors.
    groups.left.frame.src += location.hash;
  } else { $("library-toggle").click(); }
} catch (error) {
  $("status").className = "workspace-error";
  $("status").textContent = `Could not open sources: ${error.message}`;
}
