const papers = document.getElementById("papers");
const statusEl = document.getElementById("add-status");
const fileInput = document.getElementById("add-pdf");
const urlForm = document.getElementById("add-url-form");
const urlInput = document.getElementById("add-url");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showStatus(msg, kind = "") {
  statusEl.hidden = !msg;
  statusEl.textContent = msg || "";
  statusEl.className = `add-status${kind ? ` is-${kind}` : ""}`;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || res.statusText || "request failed");
  }
}

function renderPapers(list) {
  if (!list.length) {
    papers.innerHTML = `<li class="empty">No sources yet. Add a PDF or a URL.</li>`;
    return;
  }
  papers.innerHTML = list
    .map((p) => {
      const href = `/view/${encodeURIComponent(p.paper_id)}`;
      const origin = p.origin === "web" ? "web" : "pdf";
      return `<li>
        <a href="${href}">
          <h2>${escapeHtml(p.title)}</h2>
          <p class="meta">${escapeHtml(origin)} · ${escapeHtml(p.paper_id)}</p>
          <p class="counts">${p.claim_count} claims<br>${p.quote_count} quotes</p>
        </a>
      </li>`;
    })
    .join("");
}

async function loadCatalog() {
  const catalog = await fetch("/api/catalog").then((r) => r.json());
  renderPapers(catalog.papers || []);
}

function failMsg(err) {
  const raw = err && err.message ? err.message : String(err);
  if (raw === "Failed to fetch" || raw === "NetworkError when attempting to fetch resource.") {
    return "Could not reach the literature server. Open http://127.0.0.1:8765/ in this tab and try again.";
  }
  return raw;
}

async function uploadPdf(file) {
  const url = new URL("/api/sources", location.origin);
  url.searchParams.set("name", file.name);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  const row = await readJson(res);
  if (!res.ok) throw new Error(row.error || "could not add PDF");
  return row;
}

async function addPdf(file) {
  showStatus(`Adding ${file.name}…`);
  const row = await uploadPdf(file);
  location.href = `/view/${encodeURIComponent(row.paper_id)}`;
}

// One file opens it; a batch stays here so the run is visible as it fills.
async function addPdfs(files) {
  if (files.length === 1) {
    await addPdf(files[0]);
    return;
  }
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    showStatus(`Adding ${i + 1} of ${files.length}: ${files[i].name}…`);
    try {
      await uploadPdf(files[i]);
    } catch (err) {
      failed.push(`${files[i].name} — ${failMsg(err)}`);
    }
  }
  await loadCatalog();
  const added = files.length - failed.length;
  if (failed.length) {
    showStatus(`Added ${added} of ${files.length}. Failed: ${failed.join("; ")}`, "err");
  } else {
    showStatus(`Added ${added} PDFs. Open a paper's Claims tab for extraction progress or setup errors.`);
  }
}

async function addSite(href) {
  showStatus("Adding site…");
  const res = await fetch(new URL("/api/sources", location.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: href }),
  });
  const row = await readJson(res);
  if (!res.ok) throw new Error(row.error || "could not add site");
  location.href = `/view/${encodeURIComponent(row.paper_id)}`;
}

document.getElementById("add-pdf-btn").addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const files = [...(fileInput.files || [])];
  fileInput.value = "";
  if (!files.length) return;
  try {
    await addPdfs(files);
  } catch (err) {
    showStatus(failMsg(err), "err");
  }
});

urlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addSite(urlInput.value.trim());
  } catch (err) {
    showStatus(failMsg(err), "err");
  }
});

const picker = document.querySelector(".picker");
picker.addEventListener("dragover", (e) => {
  e.preventDefault();
  picker.classList.add("is-drop");
});
picker.addEventListener("dragleave", () => picker.classList.remove("is-drop"));
picker.addEventListener("drop", async (e) => {
  e.preventDefault();
  picker.classList.remove("is-drop");
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (!files.length) {
    showStatus("Drop a PDF, or paste a URL below.", "err");
    return;
  }
  try {
    await addPdfs(files);
  } catch (err) {
    showStatus(failMsg(err), "err");
  }
});

try {
  await loadCatalog();
} catch {
  papers.innerHTML = `<li class="empty">Could not load this run.</li>`;
}
