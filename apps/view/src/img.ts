/**
 * edf-view `GET /img/:token` (bundled to api/img.js). Web-standard `fetch` export
 * (vercel.com/docs/functions/runtimes/node-js). Logic: app.ts; fetching: @edf/fetch.
 */
import { fetchImage } from "@edf/fetch";
import { contextWaitUntil } from "./app";
import { runtime, unavailable } from "./runtime";

export default {
  fetch(request: Request): Promise<Response> {
    const r = runtime(fetchImage);
    return "app" in r ? r.app.img(request, contextWaitUntil()) : Promise.resolve(unavailable());
  },
};
