/** Describe extraction from observed worker state, never from a click alone. */
export function extractionView(status) {
  const queued = status.state === "queued";
  const running = status.state === "running" || queued;
  return {
    label: queued ? "Queued…" : running ? "Extracting…" : status.claim_count > 0 ? "Re-extract claims" : "Extract claims",
    disabled: running || !status.available,
    message: status.message || status.reason || (status.model ? `${status.agent} · ${status.model}` : "Runs separately for this PDF."),
    error: status.state === "error",
  };
}

/** Bind the current source's extraction action; ignore late responses after navigation. */
export function bindExtraction({ onComplete }) {
  const root = document.getElementById("claim-extraction");
  const button = document.getElementById("extract-claims");
  const note = document.getElementById("extract-status");
  let paperId = "";
  let generation = 0;
  let timer;
  let state = {};
  const refreshed = new Set();

  function render() {
    const view = extractionView(state);
    button.textContent = view.label;
    button.disabled = view.disabled;
    note.textContent = view.message;
    root.classList.toggle("has-error", view.error);
  }

  async function refresh(token) {
    try {
      const response = await fetch(`/api/extraction/${encodeURIComponent(paperId)}`);
      if (!response.ok) throw new Error("Could not check extraction. Click to retry.");
      const status = await response.json();
      if (token !== generation) return;
      state = status;
      render();
      if (status.state === "complete" && !refreshed.has(status.job_id)) {
        refreshed.add(status.job_id);
        onComplete(paperId);
      }
      if (["running", "queued"].includes(status.state)) timer = setTimeout(() => refresh(token), 1200);
    } catch (error) {
      if (token !== generation) return;
      state = { ...state, state: "error", available: true, message: error.message };
      render();
    }
  }

  button.onclick = async () => {
    if (button.disabled || !paperId) return;
    const token = ++generation;
    clearTimeout(timer);
    button.disabled = true;
    note.textContent = "Starting extraction…";
    try {
      const response = await fetch(`/api/extraction/${encodeURIComponent(paperId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const status = await response.json();
      if (!response.ok) throw new Error(status.error || "Could not start extraction. Retry.");
      if (token !== generation) return;
      state = { ...state, ...status };
      render();
      await refresh(token);
    } catch (error) {
      if (token !== generation) return;
      state = { ...state, state: "error", message: error.message };
      render();
    }
  };

  return {
    setPaper(id) {
      if (paperId === id) return;
      paperId = id;
      const token = ++generation;
      clearTimeout(timer);
      root.hidden = !id;
      state = { available: false, message: "Checking extraction…" };
      render();
      if (id) refresh(token);
    },
  };
}
