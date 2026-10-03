/**
 * The parts of what the email frame shows that need no database: Gmail's default font going first in
 * the head (withDefaultFont), and the app keeping every frame in its light version. Kept apart from
 * view-source.test.ts, whose DB suites need a test database even to be collected.
 */
import { describe, expect, it } from "vitest";

describe("withDefaultFont", () => {
  it("withDefaultFont puts the style first in the head, or right after the doctype if the head isn't where it should be", async () => {
    const { withDefaultFont, VIEWER_DEFAULT_FONT_CSS: css } = await import("@/server/view-source");
    expect(withDefaultFont('<!DOCTYPE html>\n<html lang="en"><head><title>x</title></head><body></body></html>')).toBe(
      `<!DOCTYPE html>\n<html lang="en"><head>${css}<title>x</title></head><body></body></html>`,
    );
    // "<head>" inside a quoted attribute value is not the head.
    expect(withDefaultFont('<!DOCTYPE html>\n<html lang="a><head>b"><head></head><body></body></html>')).toBe(
      `<!DOCTYPE html>\n<html lang="a><head>b"><head>${css}</head><body></body></html>`,
    );
    // No head where it should be: right after the doctype, which the parser also puts in the head.
    expect(withDefaultFont("<!DOCTYPE html>\n<html><body><p>x</p></body></html>")).toBe(
      `<!DOCTYPE html>\n${css}<html><body><p>x</p></body></html>`,
    );
  });
});

describe("the light version of every email frame", () => {
  it("the app sets color-scheme: light on iframes, so an email's dark-mode CSS stays off in the dark theme", async () => {
    // A frame's prefers-color-scheme follows its <iframe> element's color-scheme (checked in Chrome
    // 148); nothing inside the email's document can override it (view-source.ts VIEWER_DEFAULT_FONT_CSS).
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\n\s*iframe\s*\{\s*color-scheme:\s*light;\s*\}/);
  });
});
