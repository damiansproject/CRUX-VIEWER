import assert from "node:assert/strict";
import { test } from "node:test";
import { filterCommands, slashPrefix } from "../.claude/skills/crux-viewer/scripts/viewer/slash_menu.mjs";

test("slashPrefix is only the command being typed", () => {
  assert.equal(slashPrefix("/"), "");
  assert.equal(slashPrefix("/crux"), "crux");
  assert.equal(slashPrefix("/crux "), null);
  assert.equal(slashPrefix("please /crux"), null);
  assert.equal(slashPrefix("hello"), null);
});

test("filterCommands matches name or description", () => {
  const rows = [
    { name: "/crux", description: "Hypothesis loop" },
    { name: "/crux-claims", description: "Turn papers into claims" },
    { name: "/create-skill", description: "Author a Cursor skill" },
  ];
  assert.deepEqual(
    filterCommands(rows, "crux").map((r) => r.name),
    ["/crux", "/crux-claims"]
  );
  assert.deepEqual(
    filterCommands(rows, "claim").map((r) => r.name),
    ["/crux-claims"]
  );
  assert.deepEqual(
    filterCommands(rows, "cursor").map((r) => r.name),
    ["/create-skill"]
  );
  assert.deepEqual(filterCommands(rows, ""), rows);
});
