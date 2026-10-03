/**
 * Authentication-Results parsing (RFC 8601) restricted to Gmail's own verdict: only the topmost
 * header whose authserv-id is `mx.google.com` is trusted (DESIGN-SCORE §9; RESEARCH-NOTES
 * "Trust only Authentication-Results from our own mailbox provider"). Headers from other
 * authserv-ids — including forged ones inserted by a sender — are ignored.
 */
import type { AuthFacts, AuthVerdict } from "../types";
import { registrableDomain } from "../util/domain";

export const TRUSTED_AUTHSERV_ID = "mx.google.com";

const MAX_VALUE = 16 * 1024;
const MAX_COMMENT_DEPTH = 32;

interface Segment {
  text: string;
  comments: string[];
}

/**
 * Splits a header value into `;`-separated segments, removing (possibly nested) comments and
 * collecting their text. Quoted strings are preserved. Linear time.
 */
export function splitAuthResSegments(value: string): Segment[] {
  const v = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value;
  const segments: Segment[] = [];
  let cur = "";
  let comments: string[] = [];
  let comment = "";
  let depth = 0;
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as string;
    if (escaped) {
      if (depth > 0) comment += c;
      else cur += c;
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (inQuote) {
      cur += c;
      if (c === '"') inQuote = false;
      continue;
    }
    if (depth > 0) {
      if (c === "(") {
        if (depth < MAX_COMMENT_DEPTH) depth++;
        comment += c;
      } else if (c === ")") {
        depth--;
        if (depth === 0) {
          comments.push(comment);
          comment = "";
          cur += " ";
        } else {
          comment += c;
        }
      } else {
        comment += c;
      }
      continue;
    }
    if (c === "(") {
      depth = 1;
    } else if (c === '"') {
      inQuote = true;
      cur += c;
    } else if (c === ";") {
      segments.push({ text: cur, comments });
      cur = "";
      comments = [];
    } else {
      cur += c;
    }
  }
  if (depth > 0 && comment) comments.push(comment);
  segments.push({ text: cur, comments });
  return segments;
}

const VERDICTS: Record<string, AuthVerdict> = {
  pass: "pass",
  fail: "fail",
  hardfail: "fail",
  softfail: "softfail",
  neutral: "neutral",
  none: "none",
  temperror: "temperror",
  permerror: "permerror",
  policy: "policy",
};

function toVerdict(result: string): AuthVerdict {
  return VERDICTS[result.toLowerCase()] ?? "unknown";
}

interface ResInfo {
  method: string;
  result: AuthVerdict;
  props: Map<string, string>;
  comments: string[];
}

function parseResInfo(seg: Segment): ResInfo | null {
  const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const method = first.slice(0, eq).split("/")[0]?.toLowerCase() ?? "";
  const result = toVerdict(first.slice(eq + 1));
  const props = new Map<string, string>();
  for (let i = 1; i < tokens.length && i < 40; i++) {
    const t = tokens[i] as string;
    const e = t.indexOf("=");
    if (e <= 0) continue;
    const key = t.slice(0, e).toLowerCase();
    let val = t.slice(e + 1);
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!props.has(key)) props.set(key, val);
  }
  return { method, result, props, comments: seg.comments };
}

function domainFromIdentity(identity: string | undefined): string | null {
  if (!identity) return null;
  const at = identity.lastIndexOf("@");
  const d = (at >= 0 ? identity.slice(at + 1) : identity).trim().toLowerCase();
  return d.length > 0 ? d : null;
}

/** AuthFacts for "no trusted Authentication-Results found". */
export function unknownAuthFacts(): AuthFacts {
  return {
    found: false,
    spf: "unknown",
    dkim: "unknown",
    dmarc: "unknown",
    arc: "unknown",
    dkimPassDomains: [],
    dmarcHeaderFrom: null,
    dmarcPolicy: null,
    spfMailFromDomain: null,
  };
}

/** The authserv-id (first token of the first segment), lower-case. */
export function authservIdOf(value: string): string {
  const first = splitAuthResSegments(value.slice(0, 512))[0]?.text.trim() ?? "";
  return (first.split(/\s+/)[0] ?? "").toLowerCase();
}

/**
 * Parses the topmost Authentication-Results header whose authserv-id is `authservId`.
 * `values` must be in message order (topmost first).
 */
export function parseAuthenticationResults(
  values: readonly string[],
  authservId: string = TRUSTED_AUTHSERV_ID,
): AuthFacts {
  const wanted = authservId.toLowerCase();
  for (const value of values) {
    if (authservIdOf(value) !== wanted) continue;
    return parseTrusted(value);
  }
  return unknownAuthFacts();
}

function parseTrusted(value: string): AuthFacts {
  const segments = splitAuthResSegments(value).slice(1, 64);
  const facts: AuthFacts = {
    found: true,
    spf: "none",
    dkim: "none",
    dmarc: "none",
    arc: "none",
    dkimPassDomains: [],
    dmarcHeaderFrom: null,
    dmarcPolicy: null,
    spfMailFromDomain: null,
  };
  const dkimResults: AuthVerdict[] = [];
  const passDomains = new Set<string>();
  let spfSeen = false;
  let dmarcSeen = false;
  let arcSeen = false;

  for (const seg of segments) {
    const r = parseResInfo(seg);
    if (!r) continue;
    switch (r.method) {
      case "dkim": {
        dkimResults.push(r.result);
        if (r.result === "pass") {
          const d = r.props.get("header.d") ?? domainFromIdentity(r.props.get("header.i")) ?? null;
          const reg = registrableDomain(d);
          if (reg) passDomains.add(reg);
        }
        break;
      }
      case "spf": {
        if (spfSeen) break;
        spfSeen = true;
        facts.spf = r.result;
        const mailFrom = domainFromIdentity(r.props.get("smtp.mailfrom"));
        facts.spfMailFromDomain = registrableDomain(mailFrom);
        break;
      }
      case "dmarc": {
        if (dmarcSeen) break;
        dmarcSeen = true;
        facts.dmarc = r.result;
        const hf = r.props.get("header.from");
        facts.dmarcHeaderFrom = hf ? hf.toLowerCase() : null;
        for (const c of r.comments) {
          const p = /(?:^|\s)p=([a-z]+)/i.exec(c)?.[1];
          if (p) {
            facts.dmarcPolicy = p.toLowerCase();
            break;
          }
        }
        if (!facts.dmarcPolicy) {
          const p = r.props.get("policy.dmarc") ?? r.props.get("policy.published-domain-policy");
          if (p) facts.dmarcPolicy = p.toLowerCase();
        }
        break;
      }
      case "arc": {
        if (arcSeen) break;
        arcSeen = true;
        facts.arc = r.result;
        break;
      }
      default:
        break;
    }
  }

  if (dkimResults.length > 0) {
    // Any passing signature authenticates the message (DMARC evaluates passing signatures).
    if (dkimResults.includes("pass")) facts.dkim = "pass";
    else if (dkimResults.includes("fail")) facts.dkim = "fail";
    else facts.dkim = dkimResults[0] ?? "none";
  }
  facts.dkimPassDomains = [...passDomains];
  return facts;
}
