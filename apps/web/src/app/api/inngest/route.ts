/**
 * Inngest endpoint (FREE-TIER.md §4.7): its own route file with a minimal import graph; heavy
 * modules load inside steps. Requests are verified with the signing key (+ fallback key).
 */
import { serve } from "inngest/next";
import { inngest } from "@/server/inngest/client";
import { FUNCTIONS } from "@/server/inngest/functions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions: FUNCTIONS });
