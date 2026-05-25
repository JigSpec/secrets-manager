/**
 * renderSimpleMarkdown — lightweight, XSS-safe markdown → HTML renderer.
 *
 * Processing order (critical for XSS safety):
 *   1. HTML-escape ALL of: & < > "
 *   2. Split on blank lines into blocks
 *   3. Per block: detect headings, bullet lists, or fallback to paragraph
 *   4. Apply inline formatting inside each block
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyInline(s: string): string {
  // Links: [text](url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text, url) => {
      // Only allow safe protocols — url is already HTML-escaped at this point
      const isAllowed = /^https?:\/\//i.test(url) || url.startsWith("#");
      if (!isAllowed) return text; // strip the link, keep the label text
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="underline text-blue-600 hover:text-blue-800">${text}</a>`;
    },
  );
  // Bold: **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic: *text* (not **)
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  // Inline code: `code`
  s = s.replace(
    /`([^`]+)`/g,
    "<code class=\"font-mono text-sm bg-muted px-1 rounded\">$1</code>",
  );
  return s;
}

export function renderSimpleMarkdown(text: string): string {
  if (!text) return "";

  // Step 1: HTML-escape FIRST (XSS safety)
  const escaped = escapeHtml(text);

  // Step 2: split into blocks on 2+ newlines
  const blocks = escaped.split(/\n{2,}/);

  const rendered = blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";

    // ### heading
    const h3Match = trimmed.match(/^### (.+)/);
    if (h3Match) {
      return `<h3 class="text-base font-semibold mt-4 mb-1">${applyInline(h3Match[1]!)}</h3>`;
    }

    // ## heading
    const h2Match = trimmed.match(/^## (.+)/);
    if (h2Match) {
      return `<h2 class="text-lg font-semibold mt-4 mb-1">${applyInline(h2Match[1]!)}</h2>`;
    }

    // Bullet list: all lines start with "- "
    const lines = trimmed.split("\n");
    const allBullets = lines.every((l) => l.trimStart().startsWith("- "));
    if (allBullets) {
      const items = lines
        .map((l) => `<li>${applyInline(l.trimStart().slice(2))}</li>`)
        .join("");
      return `<ul class="list-disc list-inside space-y-1">${items}</ul>`;
    }

    // Paragraph: join lines with <br />
    const content = lines.map(applyInline).join("<br />");
    return `<p class="leading-relaxed">${content}</p>`;
  });

  return rendered.filter(Boolean).join("\n");
}
