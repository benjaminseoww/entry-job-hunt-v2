/** Browsers cannot inline .docx; this HTML is the readable stand-in. */

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

function inline(text) {
  let out = esc(text);
  // `text` is already escaped, so `href` already has `&` → `&amp;`. Escaping
  // again would turn a query string into `&amp;amp;` and break the link.
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label, href) =>
    `<a href="${href}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return out;
}

/** CV-shaped subset (headings, lists, emphasis, links) — not a general markdown engine. */
export function mdToGaramondHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let list = false;
  const flushList = () => {
    if (list) {
      html.push("</ul>");
      list = false;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        html.push("<ul>");
        list = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    flushList();
    html.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return html.join("\n");
}

export function garamondPreviewHtml({ markdown, downloadHref, filename }) {
  const download = downloadHref
    ? ` · <a href="${esc(downloadHref)}">Download ${esc(filename || "the Word file")}</a>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview of the Word file</title>
<style>
  body {
    font-family: Garamond, "EB Garamond", "Palatino Linotype", Palatino, "Times New Roman", serif;
    font-size: 12pt;
    line-height: 1.05;
    color: #000;
    background: #fff;
    max-width: 8.5in;
    margin: 0 auto;
    padding: 0.4375in 0.5in 0.2875in;
  }
  .preview-banner {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    background: #f4efe6;
    border-bottom: 1px solid #d9d0c3;
    margin: -0.4375in -0.5in 1em;
    padding: 0.65em 1em;
  }
  .preview-banner a { color: #1155CC; }
  h1 {
    font-size: 18pt;
    font-weight: bold;
    text-align: center;
    border-bottom: 0.75pt solid #000;
    padding-bottom: 2pt;
    margin: 0 0 8pt;
  }
  h2 {
    font-size: 12pt;
    font-weight: bold;
    text-transform: uppercase;
    border-bottom: 0.75pt solid #000;
    margin: 12pt 0 6pt;
    letter-spacing: 0.02em;
  }
  h3 { font-size: 12pt; font-weight: bold; margin: 8pt 0 2pt; }
  p { margin: 0 0 6pt; }
  a { color: #1155CC; text-decoration: underline; }
  ul { list-style: none; margin: 0 0 6pt; padding-left: 0.25in; }
  li { text-indent: -0.25in; padding-left: 0.25in; }
  li::before { content: "▪ "; }
</style>
</head>
<body>
<p class="preview-banner">Preview of the Word file${download}</p>
${mdToGaramondHtml(markdown)}
</body>
</html>
`;
}
