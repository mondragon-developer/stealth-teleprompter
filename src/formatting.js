// Deliberately small Markdown subset. Escape HTML before adding our own tags.
export function mdLite(text) {
  const inline = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (!line.trim() || heading) {
      flush();
      if (heading) blocks.push(`<h2>${inline(heading[1])}</h2>`);
    } else paragraph.push(inline(line));
  }
  flush();
  return blocks.join("");
}

export function formatSelection(text, start, end, style) {
  if (style === "heading") {
    start = text.lastIndexOf("\n", start - 1) + 1;
    const next = text.indexOf("\n", end);
    end = next < 0 ? text.length : next;
    const lines = text.slice(start, end).split("\n");
    const remove = lines.every((line) => /^#{1,6} /.test(line));
    const replacement = lines.map((line) => remove ? line.replace(/^#{1,6} /, "") : "## " + line.replace(/^#{1,6} /, "")).join("\n");
    return { start, end, replacement, selectStart: start, selectEnd: start + replacement.length };
  }
  const selected = text.slice(start, end) || "bold text";
  const remove = selected.startsWith("**") && selected.endsWith("**") && selected.length > 4;
  const replacement = remove ? selected.slice(2, -2) : `**${selected}**`;
  return { start, end, replacement, selectStart: start, selectEnd: start + replacement.length };
}
