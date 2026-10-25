import assert from "node:assert/strict";
import { test } from "node:test";
import { extractionView } from "../.claude/skills/crux-viewer/scripts/viewer/extraction.mjs";

test("empty and populated sources offer the appropriate action", () => {
  assert.equal(extractionView({ available: true, claim_count: 0 }).label, "Extract claims");
  assert.equal(extractionView({ available: true, claim_count: 4 }).label, "Re-extract claims");
});

test("running worker disables duplicate extraction", () => {
  const view = extractionView({ available: true, state: "running", message: "Reading PDF…" });
  assert.equal(view.disabled, true);
  assert.equal(view.label, "Extracting…");
  assert.equal(view.message, "Reading PDF…");
});

test("queued import exposes its wait without allowing duplicate extraction", () => {
  const view = extractionView({ available: true, state: "queued", message: "Waiting for another PDF…" });
  assert.equal(view.disabled, true);
  assert.equal(view.label, "Queued…");
  assert.equal(view.message, "Waiting for another PDF…");
});

test("failed extraction exposes retry and does not claim completion", () => {
  const view = extractionView({ available: true, state: "error", claim_count: 2,
    message: "Quote not found. Existing claims were kept." });
  assert.equal(view.disabled, false);
  assert.equal(view.label, "Re-extract claims");
  assert.equal(view.error, true);
  assert.match(view.message, /Existing claims were kept/);
});

test("unavailable worker explains how to recover", () => {
  const view = extractionView({ available: false, reason: "Install Claude Code and sign in." });
  assert.equal(view.disabled, true);
  assert.match(view.message, /Install Claude Code/);
});
