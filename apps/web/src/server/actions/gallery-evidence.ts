"use server";
/**
 * The detail view's "How we judged this" panel (components/gallery/verdict-evidence.tsx): one of
 * the caller's own gallery designs, explained from its stored facts (lib/gallery-evidence.ts).
 * Read-only, RLS-scoped (queries/gallery-evidence.ts), metered like every Server Action (one
 * invocation through the session lookup). Asked once when a design is opened, never on a timer.
 */
import { z } from "zod";
import { verdictEvidence, type VerdictEvidence } from "@/lib/gallery-evidence";
import { ok, toFailure, type ActionResult } from "./result";
import { galleryEvidenceInput } from "../queries/gallery-evidence";
import { requireUserOrThrow } from "../session";

/**
 * The evidence for one design, or null when it has no score yet — or isn't the caller's, or isn't
 * in the gallery: another user's id gets exactly what an unknown id gets.
 */
export async function galleryEvidence(
  emailId: unknown,
): Promise<ActionResult<VerdictEvidence | null>> {
  try {
    const user = await requireUserOrThrow();
    const id = z.string().uuid().parse(emailId);
    const input = await galleryEvidenceInput(user.userId, id);
    return ok(input ? verdictEvidence(input) : null);
  } catch (err) {
    return toFailure(err);
  }
}
