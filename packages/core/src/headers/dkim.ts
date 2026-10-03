/** DKIM-Signature tag-list parsing (RFC 6376 §3.5), bounded. Signatures are never verified here. */

export interface DkimSignatureInfo {
  /** d= signing domain, lower-case. */
  domain: string | null;
  /** s= selector, lower-case. */
  selector: string | null;
  /** h= signed header names, lower-case. */
  signedHeaders: string[];
}

const MAX_VALUE = 8192;
const MAX_TAGS = 32;

/** Parses one DKIM-Signature value. Unknown / malformed tags are ignored. */
export function parseDkimSignature(value: string): DkimSignatureInfo {
  const info: DkimSignatureInfo = { domain: null, selector: null, signedHeaders: [] };
  const v = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value;
  const parts = v.split(";");
  for (let i = 0; i < parts.length && i < MAX_TAGS; i++) {
    const part = parts[i] as string;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const tag = part.slice(0, eq).trim().toLowerCase();
    // Folding whitespace is allowed anywhere inside tag values.
    const val = part.slice(eq + 1).replace(/\s+/g, "");
    if (tag === "d" && val) info.domain = val.toLowerCase();
    else if (tag === "s" && val) info.selector = val.toLowerCase();
    else if (tag === "h" && val) {
      info.signedHeaders = val
        .toLowerCase()
        .split(":")
        .filter((h) => h.length > 0 && h.length <= 128)
        .slice(0, 128);
    }
  }
  return info;
}

/** Parses up to `limit` DKIM-Signature header values. */
export function parseDkimSignatures(values: readonly string[], limit = 20): DkimSignatureInfo[] {
  return values.slice(0, limit).map(parseDkimSignature);
}
