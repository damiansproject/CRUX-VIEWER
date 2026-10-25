export function slashPrefix(text) {
  const line = String(text ?? "").split("\n").pop() ?? "";
  const match = line.match(/^\/([^\s]*)$/);
  return match ? match[1] : null;
}

export function filterCommands(rows, prefix) {
  const needle = String(prefix ?? "")
    .toLowerCase()
    .replace(/^\//, "");
  if (!needle) return [...rows];
  return rows.filter((row) => {
    const name = String(row.name || "")
      .replace(/^\//, "")
      .toLowerCase();
    const desc = String(row.description || "").toLowerCase();
    return name.includes(needle) || desc.includes(needle);
  });
}
