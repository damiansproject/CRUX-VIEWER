import { addAttachment, chipLabel, dropAttachment } from "./selection_menu.mjs";
import { filterCommands, slashPrefix } from "./slash_menu.mjs";

const TABS = ["info", "claims", "chat"];
const CHAT_STALE_MS = 25_000;

/** Check for unanswered turns, optionally restricted to the session's picked-up message. */
export function shouldShowTyping(messages, watching, respondingTo = undefined) {
  if (!watching || !Array.isArray(messages) || !messages.length) return false;
  let pending = [];
  for (const message of messages) {
    if (message?.role === "user") pending.push(message);
    else if (message?.role === "assistant") {
      if (!message.in_reply_to) pending = [];
      else {
        const index = pending.findIndex((row) => row.id === message.in_reply_to);
        if (index >= 0) pending = pending.slice(index + 1);
      }
    }
  }
  return respondingTo === undefined ? pending.length > 0 : pending.some((row) => row.id === respondingTo);
}

/** Bind the shared sidebar; changing its source preserves the conversation and draft. */
export function bindRailPanes({ paperId, chatId = paperId, claimCount = null, poll = true, onCitation = null, getContext = () => ({}) }) {
  const tabs = {
    info: document.getElementById("tab-info"),
    claims: document.getElementById("tab-claims"),
    chat: document.getElementById("tab-chat"),
  };
  const panes = {
    info: document.getElementById("info-pane"),
    claims: document.getElementById("claim-pane"),
    chat: document.getElementById("chat-pane"),
  };
  const metaEl = document.getElementById("meta");
  const logEl = document.getElementById("chat-log");
  const watchEl = document.getElementById("chat-watch");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const send = document.getElementById("chat-send");
  const slashEl = document.getElementById("chat-slash");
  const attachEl = document.getElementById("chat-attach");
  if (!tabs.claims || !panes.claims) return;

  const firstTab = claimCount === 0 ? "info" : "claims";
  const state = {
    tab: firstTab,
    info: null,
    chat: { messages: [], watching: false },
    seenAssistant: 0,
    unread: false,
    absOpen: false,
    poll: 0,
    resolving: "",
    infoError: "",
    commands: [],
    slashIndex: 0,
    slashDismissed: null,
    slashQuery: null,
    attachments: [],
    sending: false,
    draftRevision: 0,
    chatError: "",
    chatCheckedAt: 0,
    chatRequest: 0,
    chatAppliedRequest: 0,
  };
  const markdown = globalThis.markdownit?.({ html: false, breaks: true });
  if (markdown) {
    markdown.disable("image");
    markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
      tokens[index].attrSet("target", "_blank");
      tokens[index].attrSet("rel", "noopener noreferrer");
      return renderer.renderToken(tokens, index, options);
    };
    markdown.inline.ruler.before("link", "crux_citation", (parser, silent) => {
      if (!onCitation || parser.linkLevel) return false;
      const match = /^\[\[([^\[\]\n]+)\]\]/.exec(parser.src.slice(parser.pos));
      if (!match) return false;
      if (!silent) parser.push("crux_citation", "", 0).content = match[1];
      parser.pos += match[0].length;
      return true;
    });
    markdown.renderer.rules.crux_citation = (tokens, index, options, msg) => citationButton(msg, tokens[index].content);
  }

  function showTab(name) {
    if (!TABS.includes(name)) return;
    state.tab = name;
    if (name === "chat") state.unread = false;
    for (const key of TABS) {
      const on = key === name;
      tabs[key].setAttribute("aria-selected", on ? "true" : "false");
      tabs[key].tabIndex = on ? 0 : -1;
      panes[key].hidden = !on;
    }
    tabs.chat.classList.toggle("has-unread", state.unread);
    if (metaEl) metaEl.hidden = name !== "claims";
    if (name === "info") renderInfo();
    if (name === "chat") {
      renderChat();
      renderAttach();
      renderSlash();
      updateComposer();
      input?.focus();
    }
  }

  function field(label, value, { href } = {}) {
    const blank = value == null || String(value).trim() === "";
    if (blank) return "";
    const body = href
        ? `<dd><a href="${escapeAttr(href)}" target="_blank" rel="noopener">${escapeHtml(String(value))}</a></dd>`
        : `<dd>${escapeHtml(String(value))}</dd>`;
    return `<div><dt>${escapeHtml(label)}</dt>${body}</div>`;
  }

  function idRow(label, key, value) {
    const blank = value == null || String(value).trim() === "";
    if (blank) return "";
    const busy = state.resolving === key;
    const btn = `<button type="button" class="info-update" data-resolve="${escapeAttr(key)}" ${busy ? "disabled" : ""}>${busy ? "Updating…" : "Update"}</button>`;
    const body = `<dd><span class="info-id">${escapeHtml(String(value))}</span>${btn}</dd>`;
    return `<div><dt>${escapeHtml(label)}</dt>${body}</div>`;
  }

  function dateLine(info) {
    const parts = [info.year, info.month, info.day].filter((n) => n != null && n !== "");
    return parts.length ? parts.join(" / ") : "";
  }

  function renderInfo() {
    const info = state.info;
    const root = panes.info;
    if (!root) return;
    if (!info) {
      root.innerHTML = `<p class="info-note">Loading…</p>`;
      return;
    }
    const pdfHref = `/pdf/${encodeURIComponent(paperId)}?download=1`;
    const pdfBtn = info.can_get_pdf
      ? `<a class="info-act" href="${escapeAttr(pdfHref)}" download="${escapeAttr(info.pdf_name || "full_text.pdf")}">Get PDF</a>`
      : `<span class="info-act is-off" title="No local PDF">Get PDF</span>`;
    const urls = (info.urls || [])
      .map(
        (href, i) =>
          `<div><dt>URL ${i + 1}</dt><dd><a href="${escapeAttr(href)}" target="_blank" rel="noopener">${escapeHtml(href)}</a></dd></div>`
      )
      .join("");
    const abstract = info.abstract
      ? `<div>
        <button type="button" class="info-abs-toggle" id="info-abs-toggle">Abstract <span>${state.absOpen ? "Collapse" : "Expand"}</span></button>
          <p class="info-abs-body${state.absOpen ? "" : " is-clip"}" id="info-abs-body">${escapeHtml(info.abstract)}</p>
        </div>`
      : field("Abstract", "");
    root.innerHTML = `<article class="info-card">
      <h3 class="info-title">${escapeHtml(info.title || paperId)}</h3>
      <div class="info-actions">
        ${pdfBtn}
      </div>
      <dl class="info-fields">
        ${field("Author(s)", info.authors)}
        ${field("Date", dateLine(info))}
        ${field("Journal", info.journal)}
        ${field("Volume", info.volume)}
        ${field("Issue", info.issue)}
        ${field("Page(s)", info.pages)}
        ${info.language ? field("Language", info.language) : ""}
        ${info.translators ? field("Translator(s)", info.translators) : ""}
        ${abstract}
        ${urls || field("URL", "")}
        ${idRow("DOI", "doi", info.doi)}
        ${idRow("arXiv", "arxiv", info.arxiv)}
        ${idRow("PMID", "pmid", info.pmid)}
        ${info.issn ? field("ISSN", info.issn) : ""}
        ${info.isbn ? field("ISBN", info.isbn) : ""}
        ${field("Pages in file", info.page_count != null ? String(info.page_count) : "")}
        ${field("Source kind", info.source_type || info.origin)}
      </dl>
      ${state.infoError ? `<p class="info-note">${escapeHtml(state.infoError)}</p>` : ""}
    </article>`;
    root.querySelector("#info-abs-toggle")?.addEventListener("click", () => {
      state.absOpen = !state.absOpen;
      renderInfo();
    });
    root.querySelectorAll("[data-resolve]").forEach((btn) => {
      btn.addEventListener("click", () => resolveFrom(btn.dataset.resolve));
    });
  }

  async function resolveFrom(kind) {
    if (!kind || state.resolving) return;
    state.resolving = kind;
    state.infoError = "";
    renderInfo();
    try {
      const res = await fetch(`/api/info/${encodeURIComponent(paperId)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: kind }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not update metadata");
      }
      state.info = await res.json();
    } catch (err) {
      state.infoError = err.message || "Could not update metadata";
    } finally {
      state.resolving = "";
      renderInfo();
    }
  }

  function renderChatStatus() {
    const agent = ["Claude", "Codex", "Cursor"].includes(state.chat.agent) ? state.chat.agent : "Agent";
    const live = state.chat.watching && Date.now() - state.chatCheckedAt < CHAT_STALE_MS;
    const responding = shouldShowTyping(state.chat.messages, live, state.chat.responding_to || null);
    const pending = shouldShowTyping(state.chat.messages, true);
    watchEl.classList.toggle("is-live", responding && !state.chatError);
    if (state.chatError || state.chat.error) watchEl.textContent = state.chatError || state.chat.error;
    else if (state.sending) watchEl.textContent = "Sending…";
    else if (responding) watchEl.innerHTML = `<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>${agent} is responding…`;
    else watchEl.textContent = pending ? `Saved · waiting for ${agent}` : live ? `${agent} connected${state.chat.model ? ` · ${state.chat.model}` : ""}` : `Connect ${agent} to receive replies`;
  }

  function renderChat() {
    if (!logEl || !watchEl) return;
    renderChatStatus();
    const messages = state.chat.messages || [];
    const stamp = JSON.stringify(messages);
    if (logEl.dataset.stamp === stamp) return;
    logEl.dataset.stamp = stamp;
    const atEnd = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
    const oldScroll = logEl.scrollTop;
    if (!messages.length) {
      logEl.innerHTML = `<p class="chat-empty">Ask about the open sources, compare passages, or attach a selection. Type / for commands.</p>`;
    } else {
      const rows = Array.from(logEl.children);
      const nodes = new Map(rows.map((row) => [row.dataset.messageId, row]));
      const ids = new Set(messages.map((msg) => msg.id));
      for (const row of rows) if (!ids.has(row.dataset.messageId)) row.remove();
      const html = messages.filter((msg) => !nodes.has(msg.id))
        .map((msg) => {
          const who = msg.role === "assistant" ? (["Claude", "Codex", "Cursor"].includes(msg.agent) ? msg.agent : "Agent") : "You";
          const cited = new Set();
          const body = citationBody({ ...msg, cited });
          const quotes = (msg.attachments || [])
            .map((row, i) => cited.has(String(i + 1)) ? "" : renderChip(row, i, msg))
            .join("");
          const list = quotes ? `<div class="chat-quote-list">${quotes}</div>` : "";
          return `<div class="chat-bubble ${escapeAttr(msg.role)}" data-message-id="${escapeAttr(msg.id)}"><span class="chat-who">${who}</span>${list}<div class="chat-message">${body}</div></div>`;
        })
        .join("");
      const added = document.createRange().createContextualFragment(html);
      added.querySelectorAll(".chat-citation").forEach((button) => {
        const msg = messages.find((row) => row.id === button.dataset.message);
        const token = button.dataset.citation;
        const source = msg.attachments?.[Number(token) - 1] || { claim_id: token };
        button.addEventListener("pointerenter", () => onCitation(source, button, false));
        button.addEventListener("focus", () => onCitation(source, button, false));
        button.addEventListener("click", () => onCitation(source, button, true));
      });
      for (const row of added.children) nodes.set(row.dataset.messageId, row);
      let cursor = logEl.firstElementChild;
      for (const msg of messages) {
        const row = nodes.get(msg.id);
        if (row === cursor) cursor = cursor.nextElementSibling;
        else logEl.insertBefore(row, cursor);
      }
      logEl.scrollTop = atEnd ? logEl.scrollHeight : oldScroll;
    }
    tabs.chat.classList.toggle("has-unread", state.unread);
  }

  function citationButton(msg, token) {
    msg.cited?.add(token);
    return `<button type="button" class="chat-citation" data-message="${escapeAttr(msg.id)}" data-citation="${escapeAttr(token)}" title="Show source">${escapeHtml(token.replace(/^artifact:/, ""))}</button>`;
  }

  function citationBody(msg) {
    if (msg.role === "assistant" && markdown) return markdown.render(msg.text || "", msg);
    if (!onCitation || msg.role !== "assistant") return escapeHtml(msg.text || "");
    const text = String(msg.text || "").split(/(\[\[[^\[\]\n]+\]\])/g).map((part) => {
      if (!part.startsWith("[[") || !part.endsWith("]]")) return escapeHtml(part);
      const token = part.slice(2, -2);
      return citationButton(msg, token);
    }).join("");
    return `<div class="chat-plain">${text}</div>`;
  }

  async function loadInfo() {
    const requested = paperId;
    if (!requested) return;
    const res = await fetch(`/api/info/${encodeURIComponent(paperId)}`);
    if (!res.ok) throw new Error("info not found");
    const info = await res.json();
    if (requested !== paperId) return;
    state.info = info;
    if (state.tab === "info") renderInfo();
  }

  async function loadChat() {
    const request = ++state.chatRequest;
    const res = await fetch(`/api/chat/${encodeURIComponent(chatId)}`);
    if (!res.ok) return;
    const next = await res.json();
    if (request < state.chatAppliedRequest) return;
    state.chatAppliedRequest = request;
    const messages = next.messages || [];
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    if (assistantCount > state.seenAssistant && state.tab !== "chat") state.unread = true;
    state.seenAssistant = assistantCount;
    state.chat = next;
    state.chatCheckedAt = Date.now();
    if (state.tab === "chat") renderChat();
    else tabs.chat.classList.toggle("has-unread", state.unread);
  }

  async function sendChat(text) {
    const body = String(text || "").trim();
    const attachments = state.attachments;
    const revision = state.draftRevision;
    if ((!body && !attachments.length) || state.sending) return;
    state.sending = true;
    state.chatError = "";
    if (document.activeElement === send) input.focus();
    updateComposer();
    renderChatStatus();
    try {
      const res = await fetch(`/api/chat/${encodeURIComponent(chatId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, attachments: attachmentPayload(attachments), context: getContext() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not send");
      }
      const message = await res.json();
      state.chatAppliedRequest = ++state.chatRequest; // Earlier polls cannot replace an acknowledged message.
      if (!state.chat.messages.some((row) => row.id === message.id)) state.chat.messages.push(message);
      if (state.draftRevision === revision) input.value = "";
      state.attachments = state.attachments.filter((row) => !attachments.includes(row));
      state.slashDismissed = null;
      renderAttach();
      renderChat();
      renderSlash();
    } catch (err) {
      state.chatError = `${err.message || "Could not send"}. Your draft is kept; try sending again.`;
    } finally {
      state.sending = false;
      updateComposer();
      renderChatStatus();
    }
  }

  function updateComposer() {
    if (!input || !send) return;
    send.disabled = state.sending || (!input.value.trim() && !state.attachments.length);
    input.style.height = "auto";
    input.style.height = `${Math.min(160, Math.max(48, input.scrollHeight))}px`;
  }

  function attachmentPayload(rows) {
    return rows.map((row) => {
      if (row.type === "image") {
        const out = { type: "image", data: row.data, paper_id: row.paper_id || paperId };
        if (row.page) out.page = row.page;
        return out;
      }
      const out = { text: row.text, paper_id: row.paper_id || paperId };
      if (row.page) out.page = row.page;
      return out;
    });
  }

  function renderChip(row, i, sent) {
    const source = sent && onCitation;
    const tag = source ? "button" : "div";
    const attrs = source ? ` type="button" data-message="${escapeAttr(sent.id)}" data-citation="${i + 1}" title="Show source"` : "";
    const citeClass = source ? " chat-citation" : "";
    if (row.type === "image") {
      const src = row.data
        ? row.data
        : row.name
          ? `/api/chat/${encodeURIComponent(chatId)}/file/${encodeURIComponent(row.name)}`
          : "";
      const loc = row.page ? `<span class="chat-chip-page">p.${escapeHtml(String(row.page))}</span>` : "";
      const img = src ? `<img src="${escapeAttr(src)}" alt="">` : "";
      const drop = sent
        ? ""
        : `<button type="button" data-drop="${i}" aria-label="Remove">×</button>`;
      return `<${tag}${attrs} class="chat-chip is-image${sent ? " is-sent" : ""}${citeClass}">${loc}${img}<span>${sent ? "Screenshot" : escapeHtml(row.name || "Box")}</span>${drop}</${tag}>`;
    }
    const loc = row.page ? `<span class="chat-chip-page">p.${escapeHtml(String(row.page))}</span>` : "";
    const drop = sent
      ? ""
      : `<button type="button" data-drop="${i}" aria-label="Remove">×</button>`;
    const body = sent ? escapeHtml(row.text || "") : escapeHtml(chipLabel(row));
    return `<${tag}${attrs} class="chat-chip${sent ? " is-sent" : ""}${citeClass}">${sent ? loc : ""}<span>${body}</span>${drop}</${tag}>`;
  }

  function renderAttach() {
    updateComposer();
    if (!attachEl) return;
    const rows = state.attachments;
    attachEl.hidden = !rows.length;
    attachEl.innerHTML = rows.map((row, i) => renderChip(row, i, false)).join("");
    attachEl.querySelectorAll("[data-drop]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.attachments = dropAttachment(state.attachments, Number(btn.dataset.drop));
        renderAttach();
      });
    });
  }

  function attachQuote(quote) {
    state.attachments = addAttachment(state.attachments, quote);
    showTab("chat");
    renderAttach();
    input?.focus();
  }

  TABS.forEach((name, i) => {
    tabs[name].addEventListener("click", () => showTab(name));
    tabs[name].addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const next = TABS[(i + dir + TABS.length) % TABS.length];
      showTab(next);
      tabs[next].focus();
    });
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (slashHits().length && slashEl && !slashEl.hidden) {
      pickSlash(state.slashIndex);
      return;
    }
    sendChat(input.value);
  });
  input?.addEventListener("input", () => {
    state.draftRevision++;
    updateComposer();
    if (state.slashDismissed !== null && input.value !== state.slashDismissed) {
      state.slashDismissed = null;
    }
    renderSlash();
  });
  input?.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const hits = slashHits();
    const open = slashEl && !slashEl.hidden && hits.length;
    if (open && e.key === "ArrowDown") {
      e.preventDefault();
      state.slashIndex = (state.slashIndex + 1) % hits.length;
      renderSlash();
      return;
    }
    if (open && e.key === "ArrowUp") {
      e.preventDefault();
      state.slashIndex = (state.slashIndex - 1 + hits.length) % hits.length;
      renderSlash();
      return;
    }
    if (open && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      pickSlash(state.slashIndex);
      return;
    }
    if (open && e.key === "Escape") {
      e.preventDefault();
      state.slashDismissed = input.value;
      renderSlash();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat(input.value);
    }
  });

  function slashHits() {
    const prefix = slashPrefix(input?.value || "");
    if (prefix === null) return [];
    if (state.slashDismissed === input.value) return [];
    return filterCommands(state.commands, prefix);
  }

  function renderSlash() {
    if (!slashEl) return;
    const prefix = slashPrefix(input?.value || "");
    const hits = slashHits();
    if (prefix === null || state.slashDismissed === input.value) {
      slashEl.hidden = true;
      slashEl.innerHTML = "";
      state.slashQuery = null;
      return;
    }
    if (state.slashQuery !== prefix) {
      state.slashQuery = prefix;
      state.slashIndex = 0;
    }
    if (!hits.length) {
      slashEl.hidden = false;
      slashEl.innerHTML = `<p class="chat-slash-empty">${state.commands.length ? "No matching command" : "No slash commands found for this session."}</p>`;
      return;
    }
    if (state.slashIndex >= hits.length) state.slashIndex = 0;
    slashEl.hidden = false;
    slashEl.innerHTML = hits
      .map((row, i) => {
        const hint = row.description ? `<span class="hint">${escapeHtml(row.description)}</span>` : "";
        return `<button type="button" role="option" class="${i === state.slashIndex ? "is-on" : ""}" data-index="${i}"><span class="cmd">${escapeHtml(row.name)}</span>${hint}</button>`;
      })
      .join("");
    slashEl.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("click", () => pickSlash(Number(btn.dataset.index)));
    });
    slashEl.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
  }

  function pickSlash(index) {
    const hits = slashHits();
    const row = hits[index] || hits[0];
    if (!row || !input) return;
    input.value = `${row.name} `;
    state.draftRevision++;
    updateComposer();
    state.slashDismissed = null;
    renderSlash();
    input.focus();
  }

  async function loadCommands() {
    try {
      const res = await fetch("/api/commands");
      if (!res.ok) return;
      const payload = await res.json();
      state.commands = payload.commands || [];
      if (state.tab === "chat") renderSlash();
    } catch {
      /* ignore */
    }
  }

  function tick() {
    if (state.tab === "chat") renderChatStatus();
    loadChat().catch(() => {});
    const ms = state.tab === "chat" ? 2500 : 8000;
    clearTimeout(state.poll);
    state.poll = setTimeout(tick, ms);
  }

  showTab(firstTab);
  // hidden previews don't poll: the rail is invisible there and a pool of
  // them would drum the server for chat and metadata nobody can see
  if (poll) {
    loadCommands();
    loadInfo().catch(() => {
      state.info = { title: paperId, urls: [], can_get_pdf: false };
      if (state.tab === "info") renderInfo();
    });
    tick();
  }
  return {
    attachQuote,
    showTab,
    setPaper(id) {
      if (id === paperId) return;
      paperId = id;
      state.info = id ? null : { title: "Choose a source from Library", urls: [], can_get_pdf: false };
      state.infoError = "";
      state.absOpen = false;
      loadInfo().catch(() => {
        state.info = { title: paperId, urls: [], can_get_pdf: false };
        if (state.tab === "info") renderInfo();
      });
      if (state.tab === "info") renderInfo();
    },
  };
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
