/**
 * edf-keys `POST /unwrap` — Vercel Node function, Web-standard `fetch` export
 * (vercel.com/docs/functions/runtimes/node-js). All logic lives in ../src.
 */
import { loadConfig } from "../src/config.js";
import { contextWaitUntil, createKeysHandler } from "../src/handler.js";

const handle = createKeysHandler(loadConfig(process.env));

export default {
  fetch(request: Request): Promise<Response> {
    return handle(request, contextWaitUntil());
  },
};
