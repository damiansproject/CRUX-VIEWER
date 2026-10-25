import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bestPassage,
  citationQuery,
  citationSpans,
  entryForAuthorYear,
  entryForNumeric,
  matchCatalog,
  parseCitations,
  quotedPhrases,
  queryTerms,
  rankPagesForLocate,
  referencesStart,
  referencesText,
  sentenceAround,
  titleTokens,
} from "../.claude/skills/crux-viewer/scripts/viewer/citations.mjs";
import {
  menuActions,
  portalPlacement,
} from "../.claude/skills/crux-viewer/scripts/viewer/selection_menu.mjs";

const PAGES = [
  "Steering vectors let us monitor and control model behavior at inference time. " +
    "Prior work extracted directions from contrastive pairs [1] and framed a " +
    "top-down view of transparency (Zou et al., 2023).",
  "We build on persona drift findings. Rimsky et al. (2024) demonstrated that " +
    "contrastive activation addition steers refusal.",
  "References " +
    "[1] N. Rimsky, N. Gabrieli, J. Schulz, M. Tong, E. Hubinger, and A. Turner. " +
    "Steering Llama 2 via contrastive activation addition. ACL, 2024. " +
    "[2] A. Zou, L. Phan, S. Chen, and J. Campbell. Representation engineering: " +
    "a top-down approach to AI transparency. arXiv, 2023. " +
    "[3] R. Chen and B. Lee. Persona vectors: monitoring and controlling " +
    "character traits in language models. 2025.",
];

const CATALOG = [
  { paper_id: "rimsky2024", title: "Steering Llama 2 via Contrastive Activation Addition" },
  { paper_id: "zou2023", title: "Representation Engineering: A Top-Down Approach to AI Transparency" },
  { paper_id: "chen2025", title: "02_Persona_Vectors_Chen_2025" },
];

test("parseCitations reads numeric markers, lists, and ranges", () => {
  assert.deepEqual(parseCitations("as shown in [2]"), [{ kind: "num", n: 2 }]);
  assert.deepEqual(
    parseCitations("prior work [1, 3] and [5–7]").map((c) => c.n),
    [1, 3, 5, 6, 7]
  );
  assert.deepEqual(parseCitations("see [2] and again [2]").length, 1);
});

test("parseCitations reads author-year citations, parenthetical and narrative", () => {
  assert.deepEqual(parseCitations("a view of transparency (Zou et al., 2023)"), [
    { kind: "ay", author: "Zou", year: "2023" },
  ]);
  assert.deepEqual(parseCitations("(see Chen & Lee, 2025; Zou et al. 2023)"), [
    { kind: "ay", author: "Chen", year: "2025" },
    { kind: "ay", author: "Zou", year: "2023" },
  ]);
  assert.deepEqual(parseCitations("Rimsky et al. (2024) demonstrated"), [
    { kind: "ay", author: "Rimsky", year: "2024" },
  ]);
});

test("parseCitations reads et-al fragments cut mid-parenthesis by the selection", () => {
  assert.deepEqual(parseCitations("helpful, harmless, and honest (Askell et al., 2021;"), [
    { kind: "ay", author: "Askell", year: "2021" },
  ]);
  assert.deepEqual(parseCitations("Bai et al., 2022). However, model personas"), [
    { kind: "ay", author: "Bai", year: "2022" },
  ]);
});

test("parseCitations ignores prose without citations", () => {
  assert.deepEqual(parseCitations("plain text with numbers like 2023 and (fig. 3)"), []);
  assert.deepEqual(parseCitations(""), []);
});

test("referencesText finds the bibliography, not an early mention", () => {
  const refs = referencesText(PAGES);
  assert.ok(refs);
  assert.ok(refs.startsWith("References"));
  assert.ok(refs.includes("Representation engineering"));
  assert.equal(referencesText(["no bibliography here", "still nothing"]), null);
  // a References heading with no year-dense text after it is not a bibliography
  assert.equal(referencesText(["We defer references to the appendix."]), null);
});

test("referencesText reads split small-caps headings like 'R EFERENCES'", () => {
  const pages = ["body text", PAGES[2].replace("References", "R EFERENCES")];
  const refs = referencesText(pages);
  assert.ok(refs);
  assert.ok(refs.includes("Representation engineering"));
});

test("referencesText survives a bibliography placed before long appendices", () => {
  // lowercase prose mention after the real heading, padded so it lands late
  const pages = [
    "Body text with citations (Zou et al., 2023).",
    ...PAGES.slice(2),
    "Appendix A. There are references to such a festival in ancient texts " +
      "from 2021, 2022 and 2023, but none survive. " + "filler text ".repeat(400),
  ];
  const refs = referencesText(pages);
  assert.ok(refs.startsWith("References"));
  assert.ok(refs.includes("Persona vectors"));
});

test("entryForNumeric returns the entry between its marker and the next", () => {
  const refs = referencesText(PAGES);
  const entry = entryForNumeric(refs, 2);
  assert.ok(entry.includes("Representation engineering"));
  assert.ok(!entry.includes("Persona vectors"));
  assert.equal(entryForNumeric(refs, 99), null);
});

test("entryForAuthorYear windows the entry around the surname", () => {
  const refs = referencesText(PAGES);
  const entry = entryForAuthorYear(refs, "Zou", "2023");
  assert.ok(entry.includes("Representation engineering"));
  assert.equal(entryForAuthorYear(refs, "Nobody", "2023"), null);
  // the window ends at the entry's closing year — no bleed into the next entry
  assert.ok(!entry.includes("Persona vectors"), entry);
});

test("entryForAuthorYear prefers the first-author entry over a co-author hit", () => {
  const refs =
    "References " +
    "Andy Arditi, Oscar Obeso, Nina Panickssery, Wes Gurnee, and Neel Nanda. " +
    "Refusal in language models is mediated by a single direction, 2024. " +
    "URL https://arxiv.org/abs/2406.11717 . " +
    "Nina Panickssery, Nick Gabrieli, and Alexander Turner. Steering llama 2 " +
    "via contrastive activation addition, 2024. URL https://arxiv.org/abs/2312.06681 .";
  const entry = entryForAuthorYear(refs, "Panickssery", "2024");
  assert.ok(entry.includes("Steering llama 2"), entry);
  assert.ok(!entry.includes("Refusal in language models"), entry);
  // a genuinely co-author-only surname still finds its entry
  const co = entryForAuthorYear(refs, "Obeso", "2024");
  assert.ok(co.includes("Refusal in language models"), co);
});

test("titleTokens drops filename prefixes and short glue, keeps years", () => {
  assert.deepEqual(titleTokens("02_Persona_Vectors_Chen_2025"), [
    "persona",
    "vectors",
    "chen",
    "2025",
  ]);
  assert.ok(titleTokens("Representation Engineering: A Top-Down Approach").includes("down"));
});

test("matchCatalog resolves entries to catalog papers and excludes self", () => {
  const refs = referencesText(PAGES);
  assert.equal(matchCatalog(entryForNumeric(refs, 2), CATALOG).paper_id, "zou2023");
  assert.equal(matchCatalog(entryForNumeric(refs, 1), CATALOG).paper_id, "rimsky2024");
  assert.equal(matchCatalog(entryForNumeric(refs, 3), CATALOG).paper_id, "chen2025");
  assert.equal(
    matchCatalog(entryForNumeric(refs, 2), CATALOG, { selfId: "zou2023" }),
    null
  );
  assert.equal(matchCatalog("an unrelated entry about databases, 1999", CATALOG), null);
});

test("matchCatalog never matches on venue words or one-token titles", () => {
  const papers = [...CATALOG, { paper_id: "junk", title: "arXiv_2502_17424" }];
  // an entry that mentions arXiv must not be hijacked by an id-titled paper
  const entry = "N. Rimsky. Steering Llama 2 via contrastive activation addition. arXiv preprint arXiv:2312.06681, 2024.";
  assert.equal(matchCatalog(entry, papers).paper_id, "rimsky2024");
  assert.equal(matchCatalog("some arXiv preprint from 2020", [{ paper_id: "junk", title: "arXiv_2502_17424" }]), null);
});

test("citationQuery strips markers but keeps the citing prose", () => {
  const q = citationQuery("Steering was framed as top-down [2] by Zou et al. (2023).");
  assert.ok(!q.includes("[2]"));
  assert.ok(!q.includes("(2023)"));
  assert.ok(!q.includes("et al"));
  assert.ok(q.includes("Steering was framed as top-down"));
  // non-citation parentheticals survive
  assert.ok(citationQuery("results (see Figure 3) hold [1]").includes("(see Figure 3)"));
});

test("quotedPhrases and queryTerms extract search material", () => {
  assert.deepEqual(quotedPhrases('the "contrastive activation addition" method'), [
    "contrastive activation addition",
  ]);
  const terms = queryTerms("These models show contrastive activation additions");
  assert.ok(terms.includes("contrastive"));
  assert.ok(terms.includes("activation"));
  assert.ok(!terms.includes("these"));
  assert.ok(!terms.includes("models"));
});

test("bestPassage lands on an exact quoted phrase first", () => {
  const hit = bestPassage(PAGES, 'they used "contrastive activation addition" for refusal');
  assert.equal(hit.exact, true);
  assert.equal(hit.page, 2);
  assert.equal(hit.spans.length, 1);
  assert.equal(
    PAGES[1].slice(hit.spans[0].start, hit.spans[0].end).toLowerCase(),
    "contrastive activation addition"
  );
});

test("bestPassage clusters query terms on the right page, across plurals", () => {
  const hit = bestPassage(PAGES, "steering vector monitoring controls behavior at inference");
  assert.equal(hit.exact, false);
  assert.equal(hit.page, 1);
  assert.ok(hit.matched >= 2);
  const painted = hit.spans.map((s) => PAGES[0].slice(s.start, s.end).toLowerCase());
  assert.ok(painted.some((t) => t.startsWith("steering")));
  assert.ok(painted.some((t) => t.startsWith("vector")));
});

test("bestPassage refuses to guess from one weak term", () => {
  assert.equal(bestPassage(PAGES, "the and of steering"), null);
  assert.equal(bestPassage(PAGES, "quantum chromodynamics lattice"), null);
});

test("citationSpans marks each citation once, inside its group", () => {
  const text =
    "Steering (Turner et al., 2024; Zou et al., 2025) works [3]. Betley et al. (2025) agree.";
  const zones = citationSpans(text);
  assert.deepEqual(zones.map((z) => text.slice(z.start, z.end)),
    ["Turner et al., 2024", "Zou et al., 2025", "3", "Betley et al. (2025)"]);
  assert.deepEqual(zones[2].cites, [{ kind: "num", n: 3 }]);
  // the loose et-al pattern must not duplicate zones inside the parenthetical
  const flat = parseCitations(text);
  assert.equal(flat.filter((c) => c.kind === "ay" && c.author === "Turner").length, 1);
});

test("sentenceAround returns the citing sentence, not the page", () => {
  const text =
    "First sentence here. We build on steering vectors (Zou et al., 2025) to monitor traits. Unrelated tail.";
  const zone = citationSpans(text)[0];
  const sentence = sentenceAround(text, zone.start, zone.end);
  assert.equal(sentence, "We build on steering vectors (Zou et al., 2025) to monitor traits.");
  // "et al." periods do not end the sentence
  const t2 = "Methods follow Betley et al. (2025) with minor changes. Next.";
  const z2 = citationSpans(t2)[0];
  assert.equal(sentenceAround(t2, z2.start, z2.end), "Methods follow Betley et al. (2025) with minor changes.");
});

test("referencesStart names the heading's page and offset", () => {
  const start = referencesStart(PAGES);
  assert.equal(start.page, 3);
  assert.equal(start.offset, 0);
  assert.equal(referencesStart(["nothing here"]), null);
});

test("rankPagesForLocate sends the term-dense pages plus page 1, trimmed", () => {
  const pages = [
    "Title page with an abstract.",
    "filler about unrelated things",
    "steering vectors control behavior via activation additions",
    "x".repeat(9000),
  ];
  const picked = rankPagesForLocate(pages, "steering vector activation additions", {
    cap: 2,
    maxChars: 100,
  });
  const ns = picked.map((p) => p.n);
  assert.ok(ns.includes(3), `dense page kept: ${ns}`);
  assert.ok(ns.includes(1), `page 1 kept: ${ns}`);
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
  assert.ok(picked.every((p) => p.text.length <= 100));
  // no query terms at all → first pages, still capped
  const blind = rankPagesForLocate(pages, "the of and", { cap: 2 });
  assert.deepEqual(blind.map((p) => p.n), [1, 2]);
});

test("portalPlacement pops above the anchor and falls below near the top", () => {
  const anchor = { left: 500, right: 700, top: 600, bottom: 620 };
  const above = portalPlacement(anchor, 600, 420, 1400, 900);
  assert.equal(above.above, true);
  assert.ok(above.top + 420 <= anchor.top, "card sits above the anchor");
  assert.ok(above.left >= 12 && above.left + 600 <= 1400 - 12);
  // caret points at the anchor centre
  assert.ok(Math.abs(above.left + above.caretX - 600) < 1);
  const below = portalPlacement({ left: 500, right: 700, top: 60, bottom: 80 }, 600, 420, 1400, 900);
  assert.equal(below.above, false);
  assert.ok(below.top >= 80, "card sits below the anchor");
  const clamped = portalPlacement({ left: 5, right: 15, top: 600, bottom: 620 }, 600, 420, 1400, 900);
  assert.equal(clamped.left, 12);
  assert.ok(clamped.caretX >= 18);
});

test("menu offers the portal action only when the selection cites something", () => {
  assert.deepEqual(
    menuActions("pdf").map((a) => a.id),
    ["highlight", "underline", "copy", "attach"]
  );
  assert.deepEqual(
    menuActions("pdf", { citations: 1 }).map((a) => a.id),
    ["portal", "highlight", "underline", "copy", "attach"]
  );
  assert.equal(menuActions("pdf", { citations: 1 })[0].label, "Open cited paper");
  assert.equal(menuActions("mark", { citations: 2 })[0].label, "Open cited paper…");
  assert.deepEqual(
    menuActions("box", { citations: 3 }).map((a) => a.id),
    ["save-image", "copy-image", "attach-image"]
  );
});
