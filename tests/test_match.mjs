import assert from "node:assert/strict";
import { test } from "node:test";
import { findAllQuotes, findQuote } from "../.claude/skills/crux-viewer/scripts/viewer/match.js";

test("findQuote collapses whitespace", () => {
  const page = "We prove a conjecture of Gao and Kitaev on Wilf-equivalence";
  const span = findQuote(page, "We prove a  conjecture of Gao  and Kitaev");
  assert.ok(span);
  assert.match(page.slice(span.start, span.end), /conjecture of Gao/);
});

test("findQuote tight-matches spaced punctuation", () => {
  const page = "sets {12345,12354} and more";
  const span = findQuote(page, "sets { 12345 , 12354 } and more");
  assert.ok(span);
  assert.match(page.slice(span.start, span.end), /\{12345,12354\}/);
});

test("findQuote joins a hyphen before a line break", () => {
  const page = "shape-Wilf-\nequivalence of patterns";
  assert.ok(findQuote(page, "shape-Wilf-equivalence of patterns"));
});

test("findQuote joins extractor hyphen-space splits like shape- Wilfequivalence", () => {
  const page = "shape-Wilf-equivalence results of Backelin";
  assert.ok(findQuote(page, "shape- Wilfequivalence results of Backelin"));
});

test("findQuote maps fi ligatures to ascii", () => {
  const page = "A \uFB01lling of a Ferrers board";
  assert.ok(findQuote(page, "A filling of a Ferrers board"));
});

test("findQuote maps curly double quotes to straight ones", () => {
  const page = "a formalization of “linear representation” (Park et al., 2023)";
  const span = findQuote(page, 'a formalization of "linear representation" (Park et al., 2023)');
  assert.ok(span);
  assert.match(page.slice(span.start, span.end), /linear representation/);
});

test("findQuote returns null when the span is not on the page", () => {
  assert.equal(findQuote("hello world", "not present"), null);
});

test("findAllQuotes finds every occurrence", () => {
  assert.deepEqual(
    findAllQuotes("foo bar foo", "foo").map((s) => [s.start, s.end]),
    [
      [0, 3],
      [8, 11],
    ],
  );
});
