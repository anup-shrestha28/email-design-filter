/**
 * `juice/client` is juice's build without web-resource-inliner (no fs, no network). juice
 * ships types only for its main entry, so the client entry is declared here with the same
 * synchronous signature, plus `inlineContent` (inline the given CSS, ignoring the document's
 * `<style>` tags). `juiceResources`/`juiceFile` are deliberately absent (DESIGN.md §8.1).
 */
declare module "juice/client" {
  import type juiceMain from "juice";

  type JuiceOptions = NonNullable<Parameters<typeof juiceMain>[1]>;
  interface JuiceClient {
    (html: string, options?: JuiceOptions): string;
    inlineContent(html: string, css: string, options?: JuiceOptions): string;
  }
  const juice: JuiceClient;
  export default juice;
}
