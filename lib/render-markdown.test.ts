// Import from the file that doesn't exist yet — will fail until Agent D creates it
import { describe, expect, it } from "vitest";
import { renderSimpleMarkdown } from "./render-markdown";

describe("renderSimpleMarkdown", () => {
  // XSS safety
  it("escapes raw <script> tags", () => {
    const out = renderSimpleMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes & characters", () => {
    const out = renderSimpleMarkdown("foo & bar");
    expect(out).toContain("&amp;");
  });

  it("escapes > and < individually", () => {
    const out = renderSimpleMarkdown("a < b > c");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
  });

  // Headings
  it("renders ## as h2", () => {
    const out = renderSimpleMarkdown("## Hello World");
    expect(out).toContain("<h2");
    expect(out).toContain("Hello World");
  });

  it("renders ### as h3", () => {
    const out = renderSimpleMarkdown("### Sub heading");
    expect(out).toContain("<h3");
    expect(out).toContain("Sub heading");
  });

  // Inline formatting
  it("renders **bold** as <strong>", () => {
    const out = renderSimpleMarkdown("**foo**");
    expect(out).toContain("<strong>foo</strong>");
  });

  it("renders *italic* as <em>", () => {
    const out = renderSimpleMarkdown("*bar*");
    expect(out).toContain("<em>bar</em>");
  });

  it("renders `code` as <code>", () => {
    const out = renderSimpleMarkdown("`baz`");
    expect(out).toContain("<code");
    expect(out).toContain("baz");
  });

  // Links
  it("renders [text](url) as <a> with target=_blank and rel=noopener noreferrer", () => {
    const out = renderSimpleMarkdown("[click here](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("click here");
  });

  // Lists
  it("renders bullet list as <ul> with <li> items", () => {
    const out = renderSimpleMarkdown("- alpha\n- beta");
    expect(out).toContain("<ul");
    expect(out).toContain("<li");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  // Paragraphs
  it("separates blank-line blocks as <p> tags", () => {
    const out = renderSimpleMarkdown("paragraph one\n\nparagraph two");
    const p1 = out.indexOf("<p");
    const p2 = out.lastIndexOf("<p");
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p1).not.toBe(p2); // two distinct <p> elements
    expect(out).toContain("paragraph one");
    expect(out).toContain("paragraph two");
  });

  // Edge cases
  it("returns empty string for empty input", () => {
    expect(renderSimpleMarkdown("")).toBe("");
  });

  it("renders bold inside a bullet item", () => {
    const out = renderSimpleMarkdown("- **important** thing");
    expect(out).toContain("<strong>important</strong>");
    expect(out).toContain("<li");
  });

  it("does not render bare < as HTML tag in output", () => {
    const out = renderSimpleMarkdown("x < 5");
    // The input < must be HTML-escaped; it must NOT appear as a raw < in the output
    expect(out).not.toContain("< 5");
    expect(out).toContain("&lt;");
  });

  it("strips javascript: protocol links and keeps the label text", () => {
    const out = renderSimpleMarkdown("[evil](javascript:alert(document.cookie))");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("evil");
  });

  it("strips data: protocol links", () => {
    const out = renderSimpleMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    expect(out).not.toContain("data:");
  });

  it("allows https: links through the protocol allowlist", () => {
    const out = renderSimpleMarkdown("[safe](https://example.com)");
    expect(out).toContain('href="https://example.com"');
  });
});
