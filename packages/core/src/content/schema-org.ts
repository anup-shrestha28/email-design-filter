/**
 * schema.org extraction from JSON-LD and microdata (DESIGN.md §7.3 rule 1, §7.7 step 1).
 * Only whitelisted scalar fields are kept — no addresses, names of people or other PII blobs.
 * Markup is sender-controlled, so values are length-capped and dates are validated by callers.
 */
import type { SchemaOrgItem } from "../types";
import { collapseWhitespace } from "../util/text";

const MAX_ITEMS = 10;
const MAX_VALUE = 200;
const MAX_DEPTH = 8;
const MAX_NODES = 500;

/** Types we keep (exact) plus families matched by suffix. */
const EXACT_TYPES = new Set([
  "Order",
  "ParcelDelivery",
  "Invoice",
  "DiscountOffer",
  "PromotionCard",
  "Offer",
  "EmailMessage",
  "ConfirmAction",
  "ViewAction",
  "TrackAction",
  "SaveAction",
  "RsvpAction",
  "Organization",
]);

function isKeptType(t: string): boolean {
  return EXACT_TYPES.has(t) || t.endsWith("Reservation") || t === "Event" || t.endsWith("Event");
}

/** Field whitelist per type family: output key → candidate source paths (first non-empty wins). */
const FIELD_MAP: Record<string, Record<string, readonly string[]>> = {
  Order: {
    orderStatus: ["orderStatus"],
    orderDate: ["orderDate"],
    price: ["price", "totalPrice", "acceptedOffer.price"],
    priceCurrency: ["priceCurrency", "acceptedOffer.priceCurrency"],
    paymentStatus: ["paymentStatus"],
  },
  ParcelDelivery: {
    trackingNumber: ["trackingNumber"],
    carrier: ["carrier.name", "carrier", "provider.name", "provider"],
    deliveryStatus: ["deliveryStatus.@type", "deliveryStatus"],
    expectedArrivalFrom: ["expectedArrivalFrom"],
    expectedArrivalUntil: ["expectedArrivalUntil"],
  },
  Invoice: {
    paymentStatus: ["paymentStatus"],
    paymentDueDate: ["paymentDueDate", "paymentDue"],
    totalPaymentDue: ["totalPaymentDue.price", "totalPaymentDue.value", "totalPaymentDue"],
    priceCurrency: ["totalPaymentDue.priceCurrency", "totalPaymentDue.currency"],
    minimumPaymentDue: ["minimumPaymentDue.price", "minimumPaymentDue"],
  },
  Reservation: {
    reservationStatus: ["reservationStatus"],
    reservationFor: ["reservationFor.@type"],
    startDate: [
      "reservationFor.startDate",
      "reservationFor.departureTime",
      "checkinTime",
      "checkinDate",
      "startTime",
      "pickupTime",
    ],
    endDate: [
      "reservationFor.endDate",
      "reservationFor.arrivalTime",
      "checkoutTime",
      "checkoutDate",
      "endTime",
    ],
  },
  DiscountOffer: {
    discountCode: ["discountCode"],
    description: ["description"],
    availabilityStarts: ["availabilityStarts", "validFrom"],
    availabilityEnds: ["availabilityEnds", "validThrough"],
    discountValue: ["discountValue"],
  },
  Offer: {
    discountCode: ["discountCode"],
    description: ["description"],
    availabilityStarts: ["availabilityStarts", "validFrom"],
    availabilityEnds: ["availabilityEnds", "validThrough"],
    price: ["price"],
    priceCurrency: ["priceCurrency"],
  },
  PromotionCard: {
    headline: ["headline"],
    price: ["price"],
    priceCurrency: ["priceCurrency"],
    discountValue: ["discountValue"],
  },
  Event: {
    name: ["name"],
    startDate: ["startDate"],
    endDate: ["endDate"],
    eventStatus: ["eventStatus"],
    eventAttendanceMode: ["eventAttendanceMode"],
    location: ["location.@type"],
  },
  EmailMessage: {
    description: ["description"],
    action: ["potentialAction.@type", "action.@type"],
  },
  Action: { name: ["name"] },
  Organization: { name: ["name"] },
};

/** Reference numbers, used internally (never exported) to stop them being taken as coupon codes. */
const REFERENCE_PATHS = [
  "orderNumber",
  "confirmationNumber",
  "reservationNumber",
  "reservationId",
  "trackingNumber",
  "invoiceNumber",
  "accountId",
  "partOfOrder.orderNumber",
];

function familyOf(type: string): string {
  if (type.endsWith("Reservation")) return "Reservation";
  if (type.endsWith("Action")) return "Action";
  if (type === "Event" || type.endsWith("Event")) return "Event";
  return type;
}

function cleanType(raw: unknown): string | null {
  const t = Array.isArray(raw) ? raw[0] : raw;
  if (typeof t !== "string") return null;
  const s = t.slice(t.lastIndexOf("/") + 1).trim();
  return /^[A-Za-z]{1,64}$/.test(s) ? s : null;
}

function scalar(v: unknown): string | null {
  if (typeof v === "string") {
    const s = collapseWhitespace(v);
    return s.length > 0 ? s.slice(0, MAX_VALUE) : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

/** Flattens a JSON-LD object into dotted paths (bounded depth/size). */
function flattenObject(
  obj: Record<string, unknown>,
  prefix: string,
  out: Record<string, string>,
  depth: number,
): void {
  if (depth > 3) return;
  for (const [k, v] of Object.entries(obj)) {
    if (Object.keys(out).length > 80) return;
    if (k === "@context") continue;
    const key = prefix + k;
    if (k === "@type") {
      const t = cleanType(v);
      if (t) out[key] = t;
      continue;
    }
    const val = Array.isArray(v) ? v[0] : v;
    const s = scalar(val);
    if (s !== null) {
      out[key] = s;
    } else if (val && typeof val === "object") {
      flattenObject(val as Record<string, unknown>, `${key}.`, out, depth + 1);
    }
  }
}

function pick(flat: Record<string, string>, type: string): Record<string, string> {
  const map = FIELD_MAP[familyOf(type)] ?? {};
  const fields: Record<string, string> = {};
  for (const [outKey, paths] of Object.entries(map)) {
    for (const p of paths) {
      const v = flat[p];
      if (v !== undefined && v.length > 0) {
        // schema.org enumerations arrive as URLs ("http://schema.org/OrderDelivered").
        fields[outKey] =
          v.startsWith("http") && v.includes("schema.org/") ? v.slice(v.lastIndexOf("/") + 1) : v;
        break;
      }
    }
  }
  return fields;
}

export interface SchemaExtraction {
  items: SchemaOrgItem[];
  /** Order / tracking / reservation numbers (lower-case) — internal only. */
  referenceNumbers: Set<string>;
}

function collectRefs(flat: Record<string, string>, refs: Set<string>): void {
  for (const p of REFERENCE_PATHS) {
    const v = flat[p];
    if (v && v.length <= 64) refs.add(v.toLowerCase());
  }
}

/** Parses JSON-LD blocks and normalises microdata items. */
export function extractSchemaOrg(
  jsonLd: readonly string[],
  microdata: readonly SchemaOrgItem[],
): SchemaExtraction {
  const items: SchemaOrgItem[] = [];
  const refs = new Set<string>();

  const consider = (obj: Record<string, unknown>): void => {
    const type = cleanType(obj["@type"]);
    if (!type || items.length >= MAX_ITEMS) return;
    const flat: Record<string, string> = {};
    flattenObject(obj, "", flat, 0);
    collectRefs(flat, refs);
    if (isKeptType(type)) items.push({ type, fields: pick(flat, type) });
  };

  for (const block of jsonLd) {
    let data: unknown;
    try {
      data = JSON.parse(block.trim().replace(/^<!--|-->$/g, ""));
    } catch {
      continue;
    }
    // Iterative traversal of @graph / arrays / nested items.
    const stack: Array<{ v: unknown; d: number }> = [{ v: data, d: 0 }];
    let visited = 0;
    while (stack.length > 0 && visited++ < MAX_NODES && items.length < MAX_ITEMS) {
      const { v, d } = stack.pop() as { v: unknown; d: number };
      if (d > MAX_DEPTH || v === null || typeof v !== "object") continue;
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0 && i >= v.length - 50; i--)
          stack.push({ v: v[i], d: d + 1 });
        continue;
      }
      const obj = v as Record<string, unknown>;
      if ("@type" in obj) consider(obj);
      const graph = obj["@graph"];
      if (Array.isArray(graph)) stack.push({ v: graph, d: d + 1 });
      // Nested kept types (e.g. EmailMessage.potentialAction, Order.partOfOrder) — top level only.
      for (const key of ["potentialAction", "partOfOrder", "reservationFor", "offers"]) {
        const nested = obj[key];
        if (nested && typeof nested === "object") {
          const n = Array.isArray(nested) ? nested[0] : nested;
          const t =
            n && typeof n === "object" ? cleanType((n as Record<string, unknown>)["@type"]) : null;
          if (t && isKeptType(t) && t !== "Event") stack.push({ v: n, d: d + 1 });
        }
      }
    }
  }

  for (const m of microdata) {
    if (items.length >= MAX_ITEMS) break;
    collectRefs(m.fields, refs);
    if (isKeptType(m.type)) items.push({ type: m.type, fields: pick(m.fields, m.type) });
  }
  return { items, referenceNumbers: refs };
}
