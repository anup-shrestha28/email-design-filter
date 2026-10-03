/**
 * A url() in a `style` attribute reaches the viewer's image rewriter with its element's raw
 * `width` and `height`, whichever order the attributes come in, so the rewriter's pixel rule can
 * refuse a 1×1 cell's background however it is written. One element's size never leaks into the
 * next element's context.
 */
import { describe, expect, it } from "vitest";
import { sanitizeForViewer, type ViewerImageContext } from "../src/index";
import { IMG_PREFIX } from "./oracle";

describe("viewer: style url() image context", () => {
  it("carries its element's width and height in any attribute order", () => {
    const seen: Array<[string, ViewerImageContext]> = [];
    const r = sanitizeForViewer(
      `<table><tr>
       <td style="background:url(https://i.example/px.png)" width="1" HEIGHT="1">a</td>
       <td width="600" height="200" style="background-image:url(https://i.example/banner.png)">b</td>
       </tr></table>
       <p width="1">c</p><span style="background:url(https://i.example/span.png)">d</span>`,
      {
        image: (u, context) => {
          seen.push([u, context]);
          return context.width === "1" && context.height === "1" ? null : `${IMG_PREFIX}x`;
        },
        cid: () => null,
        link: () => null,
      },
    );
    expect(Object.fromEntries(seen)).toEqual({
      "https://i.example/px.png": {
        kind: "css",
        width: "1",
        height: "1",
        style: "background:url(https://i.example/px.png)",
      },
      "https://i.example/banner.png": {
        kind: "css",
        width: "600",
        height: "200",
        style: "background-image:url(https://i.example/banner.png)",
      },
      "https://i.example/span.png": {
        kind: "css",
        width: null,
        height: null,
        style: "background:url(https://i.example/span.png)",
      },
    });
    expect(r.html).not.toContain("px.png");
    expect(r.images).toBe(2);
  });
});
