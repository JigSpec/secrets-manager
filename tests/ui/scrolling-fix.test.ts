/**
 * Tests for the CSS independent-scrolling fix (Issues #21, #43).
 *
 * These tests do static source analysis — they read the actual component
 * source files and assert that the required Tailwind classes are present.
 * This approach avoids the complexity of rendering Next.js server components
 * while still giving precise, meaningful signal about the DOM structure.
 *
 * ALL tests in this file are intentionally RED before the fix is applied
 * and turn GREEN once each change described in Issues #21 and #43 is made.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve source files relative to the repo root (cwd when vitest runs).
const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// Helper: extract className string(s) from a JSX element tag.
// We look for the element by a short unique anchor (e.g. "<body ") and then
// grab everything up to the closing `>` of that opening tag so we can check
// which Tailwind utilities are listed.
// Handles multiline tags by skipping `>` characters inside quoted strings.
// ---------------------------------------------------------------------------
function getOpeningTag(source: string, anchor: string): string {
  const idx = source.indexOf(anchor);
  if (idx === -1) throw new Error(`Anchor not found: ${JSON.stringify(anchor)}`);
  let i = idx;
  let inString = false;
  let quote = "";
  while (i < source.length) {
    const ch = source[i];
    if (inString) {
      if (ch === quote) inString = false;
    } else {
      if (ch === '"' || ch === "'") { inString = true; quote = ch; }
      else if (ch === ">") return source.slice(idx, i + 1);
    }
    i++;
  }
  throw new Error(`No closing > found after anchor: ${JSON.stringify(anchor)}`);
}

// ---------------------------------------------------------------------------
// 1. app/layout.tsx  — <body> must use `h-full` instead of `min-h-full`
// ---------------------------------------------------------------------------
describe("app/layout.tsx — body height class", () => {
  const src = readSrc("app/layout.tsx");

  it("body element has the h-full class", () => {
    const tag = getOpeningTag(src, "<body ");
    // Extract the className value
    expect(tag).toMatch(/\bh-full\b/);
  });

  it("body element does NOT use min-h-full (replaced by h-full)", () => {
    const tag = getOpeningTag(src, "<body ");
    expect(tag).not.toMatch(/\bmin-h-full\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. components/repo-pane.tsx  — <header> must have `shrink-0`
// ---------------------------------------------------------------------------
describe("components/repo-pane.tsx — header shrink-0", () => {
  const src = readSrc("components/repo-pane.tsx");

  it("header element has the shrink-0 class", () => {
    // Find the <header opening tag inside RepoPane
    const tag = getOpeningTag(src, "<header ");
    expect(tag).toMatch(/\bshrink-0\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. components/secret-pane.tsx  — <header> must have `shrink-0`
// ---------------------------------------------------------------------------
describe("components/secret-pane.tsx — header shrink-0", () => {
  const src = readSrc("components/secret-pane.tsx");

  it("header element has the shrink-0 class", () => {
    const tag = getOpeningTag(src, "<header ");
    expect(tag).toMatch(/\bshrink-0\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. components/scope-pane.tsx — <header> must have `shrink-0`
// ---------------------------------------------------------------------------
describe("components/scope-pane.tsx — header shrink-0", () => {
  const src = readSrc("components/scope-pane.tsx");

  it("header element (scope pane) has the shrink-0 class", () => {
    // scope-pane has one main <header> inside the non-empty section branch
    const tag = getOpeningTag(src, "<header ");
    expect(tag).toMatch(/\bshrink-0\b/);
  });
});

// ---------------------------------------------------------------------------
// 5. components/scope-pane.tsx — <thead> <th> cells must be sticky
// ---------------------------------------------------------------------------
describe("components/scope-pane.tsx — sticky thead cells", () => {
  const src = readSrc("components/scope-pane.tsx");

  // Locate the <thead> block so we only inspect that portion.
  function getTheadBlock(source: string): string {
    const start = source.indexOf("<thead");
    if (start === -1) throw new Error("<thead> not found in scope-pane.tsx");
    const end = source.indexOf("</thead>", start);
    if (end === -1) throw new Error("</thead> not found in scope-pane.tsx");
    return source.slice(start, end + "</thead>".length);
  }

  it("the first <th> (Repo column) in thead has sticky class", () => {
    const thead = getTheadBlock(src);
    const firstTh = getOpeningTag(thead, "<th ");
    expect(firstTh).toMatch(/\bsticky\b/);
  });

  it("the first <th> (Repo column) in thead has top-0 class", () => {
    const thead = getTheadBlock(src);
    const firstTh = getOpeningTag(thead, "<th ");
    expect(firstTh).toMatch(/\btop-0\b/);
  });

  it("all <th> elements in thead have sticky class", () => {
    const thead = getTheadBlock(src);
    // Find every opening <th ... > tag inside the thead block,
    // using a quote-aware regex to handle multiline/complex className attributes.
    const thTagRegex = /<th\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    const thTags = [...thead.matchAll(thTagRegex)].map((m) => m[0]);
    expect(thTags.length).toBeGreaterThan(0);
    for (const tag of thTags) {
      expect(tag).toMatch(/\bsticky\b/);
    }
  });

  it("all <th> elements in thead have top-0 class", () => {
    const thead = getTheadBlock(src);
    const thTagRegex = /<th\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    const thTags = [...thead.matchAll(thTagRegex)].map((m) => m[0]);
    expect(thTags.length).toBeGreaterThan(0);
    for (const tag of thTags) {
      expect(tag).toMatch(/\btop-0\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. components/scope-pane.tsx — <thead> <th> cells must use opaque bg-card
// ---------------------------------------------------------------------------
describe("components/scope-pane.tsx — opaque background on thead cells", () => {
  const src = readSrc("components/scope-pane.tsx");

  function getTheadBlock(source: string): string {
    const start = source.indexOf("<thead");
    const end = source.indexOf("</thead>", start);
    return source.slice(start, end + "</thead>".length);
  }

  it("<th> elements in thead use bg-card (opaque) not bg-card/30 (translucent)", () => {
    const thead = getTheadBlock(src);
    // After fix every <th> that carries a background should use opaque bg-card.
    // We check that:
    //   (a) bg-card appears in at least one th
    //   (b) bg-card/30 does NOT appear in any th (was the old semi-transparent value)
    const thTagRegex = /<th\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    const thTags = [...thead.matchAll(thTagRegex)].map((m) => m[0]);
    expect(thTags.length).toBeGreaterThan(0);

    const hasBgCard = thTags.some((tag) => /\bbg-card\b/.test(tag));
    expect(hasBgCard).toBe(true);

    for (const tag of thTags) {
      // bg-card/30 is the translucent OLD value — must not appear after fix
      expect(tag).not.toMatch(/\bbg-card\/30\b/);
    }
  });

  it("dynamic env-column <th> cells use bg-card (opaque) background", () => {
    // The env-column headers are rendered via .map() and have their own
    // className. After the fix they must also carry bg-card (opaque).
    const thead = getTheadBlock(src);
    // All th tags after the fix should include bg-card somewhere.
    const thTagRegex = /<th\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    const thTags = [...thead.matchAll(thTagRegex)].map((m) => m[0]);
    for (const tag of thTags) {
      expect(tag).toMatch(/\bbg-card\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #43 — Fix Scrolly Bars pt 2 - Revenge of the Scrolls
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. app/globals.css — html element must use dvh viewport unit
// ---------------------------------------------------------------------------
describe("app/globals.css — html dvh viewport fix", () => {
  const src = readSrc("app/globals.css");

  it("globals.css contains 100dvh for html element", () => {
    expect(src).toMatch(/100dvh/);
  });

  it("globals.css body rule includes overflow: hidden", () => {
    expect(src).toMatch(/overflow\s*:\s*hidden/);
  });
});

// ---------------------------------------------------------------------------
// 8. app/layout.tsx and globals.css — overflow-hidden constraints
// ---------------------------------------------------------------------------
describe("app/layout.tsx and globals.css — overflow-hidden constraints", () => {
  it("globals.css html rule has overflow: hidden", () => {
    const css = readSrc("app/globals.css");
    // Extract the html block and check it contains overflow: hidden
    expect(css).toMatch(/html\s*\{[^}]*overflow\s*:\s*hidden/s);
  });

  it("body element in layout.tsx has overflow-hidden class", () => {
    const src = readSrc("app/layout.tsx");
    const tag = getOpeningTag(src, "<body ");
    expect(tag).toMatch(/\boverflow-hidden\b/);
  });
});

// ---------------------------------------------------------------------------
// 9. components/workbench.tsx — DropZone must have min-h-0
// ---------------------------------------------------------------------------
describe("components/workbench.tsx — DropZone min-h-0", () => {
  const src = readSrc("components/workbench.tsx");

  it("DropZone wrapper has min-h-0 class", () => {
    const tag = getOpeningTag(src, "<DropZone ");
    expect(tag).toMatch(/\bmin-h-0\b/);
  });
});

// ---------------------------------------------------------------------------
// 10. components/repo-secrets-pane.tsx — scroll constraints
// ---------------------------------------------------------------------------
describe("components/repo-secrets-pane.tsx — scroll constraints", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");

  it("header element has shrink-0 class", () => {
    const tag = getOpeningTag(src, "<header ");
    expect(tag).toMatch(/\bshrink-0\b/);
  });

  it("scrollable div has min-h-0 class", () => {
    // Find the flex-1 overflow-auto div that is the scroll container
    const match = src.match(/<div\s+className="([^"]*)"[^>]*>/g);
    const scrollDiv = match?.find((tag) => tag.includes("overflow-auto") && tag.includes("flex-1"));
    expect(scrollDiv).toBeTruthy();
    expect(scrollDiv).toMatch(/\bmin-h-0\b/);
  });
});
