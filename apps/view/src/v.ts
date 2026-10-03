/**
 * edf-view `GET /v/:token/:emailId` (bundled to api/v.js). Web-standard `fetch` export
 * (vercel.com/docs/functions/runtimes/node-js). Logic: app.ts.
 */
import { contextWaitUntil } from "./app";
import { noImageFetch, runtime, unavailable } from "./runtime";

export default {
  fetch(request: Request): Promise<Response> {
    const r = runtime(noImageFetch);
    return "app" in r ? r.app.view(request, contextWaitUntil()) : Promise.resolve(unavailable());
  },
};
