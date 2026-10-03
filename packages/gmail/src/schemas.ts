/**
 * Zod schemas for every Gmail response we consume. Gmail responses are untrusted input: ids
 * and cursors are validated before they are interpolated into URLs or SQL, and uint64 cursors
 * stay decimal strings end to end (DATA-MODEL.md §3 "compare in SQL only").
 */
import { z } from "zod";

/** Gmail historyId: a decimal uint64 string. Never parsed to Number. */
export const uint64String = z.string().regex(/^\d{1,20}$/);
/** Gmail message/thread ids (hex in practice). */
export const gmailId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const labelId = z.string().min(1).max(256);
const pageToken = z.string().min(1).max(4096);

export const profileSchema = z.object({
  emailAddress: z.string().min(3).max(320),
  messagesTotal: z.number().int().nonnegative().optional(),
  threadsTotal: z.number().int().nonnegative().optional(),
  historyId: uint64String,
});
export type GmailProfile = z.infer<typeof profileSchema>;

const historyMessage = z.object({
  id: gmailId,
  threadId: gmailId.optional(),
  labelIds: z.array(labelId).max(1000).optional(),
});
export type HistoryMessage = z.infer<typeof historyMessage>;

const labelChange = z.object({
  message: historyMessage,
  labelIds: z.array(labelId).max(1000).optional(),
});

export const historyRecordSchema = z.object({
  id: uint64String,
  messages: z.array(historyMessage).max(10_000).optional(),
  messagesAdded: z
    .array(z.object({ message: historyMessage }))
    .max(10_000)
    .optional(),
  messagesDeleted: z
    .array(z.object({ message: historyMessage }))
    .max(10_000)
    .optional(),
  labelsAdded: z.array(labelChange).max(10_000).optional(),
  labelsRemoved: z.array(labelChange).max(10_000).optional(),
});
export type HistoryRecord = z.infer<typeof historyRecordSchema>;

export const historyListSchema = z.object({
  history: z.array(historyRecordSchema).max(10_000).optional(),
  nextPageToken: pageToken.optional(),
  historyId: uint64String,
});
export type HistoryListResponse = z.infer<typeof historyListSchema>;

export const messagesListSchema = z.object({
  messages: z
    .array(z.object({ id: gmailId, threadId: gmailId.optional() }))
    .max(10_000)
    .optional(),
  nextPageToken: pageToken.optional(),
  resultSizeEstimate: z.number().int().nonnegative().optional(),
});
export type MessagesListResponse = z.infer<typeof messagesListSchema>;

/** One node of the `format=full` MIME tree. */
export interface GmailMessagePart {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: Array<{ name: string; value: string }> | undefined;
  body?:
    | {
        size?: number | undefined;
        data?: string | undefined;
        attachmentId?: string | undefined;
      }
    | undefined;
  parts?: GmailMessagePart[] | undefined;
}

export const messagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().max(256).optional(),
    mimeType: z.string().max(256).optional(),
    filename: z.string().max(2048).optional(),
    headers: z
      .array(z.object({ name: z.string().max(1024), value: z.string().max(1_000_000) }))
      .max(5_000)
      .optional(),
    body: z
      .object({
        size: z.number().int().nonnegative().optional(),
        data: z.string().optional(),
        attachmentId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,4096}$/)
          .optional(),
      })
      .optional(),
    parts: z.array(messagePartSchema).max(1_000).optional(),
  }),
);

export const messageSchema = z.object({
  id: gmailId,
  threadId: gmailId.optional(),
  labelIds: z.array(labelId).max(1000).optional(),
  snippet: z.string().max(10_000).optional(),
  historyId: uint64String.optional(),
  internalDate: z
    .string()
    .regex(/^\d{1,16}$/)
    .optional(),
  sizeEstimate: z.number().int().nonnegative().optional(),
  raw: z.string().optional(),
  payload: messagePartSchema.optional(),
});
export type GmailMessage = z.infer<typeof messageSchema>;

export const attachmentSchema = z.object({
  attachmentId: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  data: z.string(),
});

/** Google's JSON error envelope; only machine-readable codes are kept. */
export const googleErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    status: z.string().max(64).optional(),
    errors: z
      .array(
        z.object({
          reason: z.string().max(128).optional(),
          domain: z.string().max(128).optional(),
        }),
      )
      .max(50)
      .optional(),
    details: z
      .array(z.object({ reason: z.string().max(128).optional() }).loose())
      .max(50)
      .optional(),
  }),
});
