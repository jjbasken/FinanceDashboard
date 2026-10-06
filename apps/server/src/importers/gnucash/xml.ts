import { gunzipSync } from "node:zlib";
import { rationalToCents } from "@fd/shared";
import {
  BookError,
  gnucashDate,
  rationalToMicros,
  type GncAccount,
  type GncBook,
  type GncPrice,
  type GncSplit,
  type GncTransaction,
} from "./read";

/**
 * GnuCash's default file format: XML, usually gzip-compressed (a ".gnucash" file). We read the
 * book's commodities, accounts, transactions and price database into the same shape as the
 * sqlite3 reader, so everything after this (mapping, preview, import) is shared.
 *
 * The format is regular enough for a small tokenizer: each top-level record (account,
 * transaction, price, commodity) becomes a tiny tree that is converted and then dropped.
 * Scheduled-transaction templates live in <gnc:template-transactions> and are skipped.
 */

/** Uncompressed books bigger than this are refused, to protect the server's memory. */
const MAX_XML_BYTES = 768 * 1024 * 1024;

interface Node {
  name: string;
  text: string;
  children: Node[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });

const child = (n: Node | undefined, name: string) => n?.children.find((c) => c.name === name);
const text = (n: Node | undefined, ...path: string[]) => {
  let cur = n;
  for (const p of path) cur = child(cur, p);
  return cur ? cur.text.trim() : "";
};

/** Is this file a GnuCash XML book (plain or gzip-compressed)? */
export function isGnucashXml(bytes: Uint8Array) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  return head.trimStart().startsWith("<?xml") && head.includes("gnc-v2");
}

function xmlText(bytes: Uint8Array) {
  let raw = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      raw = gunzipSync(bytes, { maxOutputLength: MAX_XML_BYTES });
    } catch (err) {
      const big = err instanceof Error && /maxOutputLength|buffer|too large/i.test(err.message);
      throw new BookError(
        big ? "That book is too large to import." : "Couldn't decompress the book; is it a GnuCash file?",
      );
    }
  }
  const xml = new TextDecoder().decode(raw);
  if (!xml.includes("<gnc-v2") && !xml.includes("<gnc:book")) {
    throw new BookError("That file isn't a GnuCash book.");
  }
  return xml;
}

/** "2011-06-19 10:59:00 +0000" (or an older local-midnight time with its offset) to a date. */
function postedDate(ts: string, gdate: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(gdate)) return gdate;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))?/.exec(ts);
  if (!m) throw new BookError(`Unrecognised date "${ts}" in the book`);
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const offsetMs = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60_000 : 0;
  const utc = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!) - offsetMs);
  return gnucashDate(utc.toISOString().slice(0, 19).replace("T", " "));
}

function rational(s: string): [number, number] {
  const [n = "0", d = "1"] = s.trim().split("/");
  return [Number(n), Number(d) || 1];
}

const slot = (slots: Node | undefined, key: string) =>
  slots?.children.find((c) => c.name === "slot" && text(c, "slot:key") === key);

export function readGnucashXml(bytes: Uint8Array): GncBook {
  const xml = xmlText(bytes);

  const commodityNames = new Map<string, { name: string; space: string }>();
  const accountNodes: Node[] = [];
  const txNodes: Node[] = [];
  const priceNodes: Node[] = [];

  // Tokenize: tags (with optional attributes) and the text between them.
  const RECORDS = new Set(["gnc:account", "gnc:transaction", "price", "gnc:commodity"]);
  const tag =
    /<(\/?)([A-Za-z_][\w:.-]*)((?:\s[^>]*?)?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
  const stack: Node[] = [];
  let templateDepth = 0;
  let last = 0;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (stack.length && m.index > last) stack[stack.length - 1]!.text += decode(xml.slice(last, m.index));
    last = tag.lastIndex;
    if (m[5] !== undefined) {
      if (stack.length) stack[stack.length - 1]!.text += m[5];
      continue;
    }
    const [, closing, name, , selfClosing] = m;
    if (!name) continue;
    if (name === "gnc:template-transactions") {
      if (closing) templateDepth--;
      else if (!selfClosing) templateDepth++;
      continue;
    }
    if (closing) {
      const node = stack.pop();
      if (node && stack.length === 0) {
        if (node.name === "gnc:account") accountNodes.push(node);
        else if (node.name === "gnc:transaction") txNodes.push(node);
        else if (node.name === "price") priceNodes.push(node);
        else if (node.name === "gnc:commodity") {
          const id = text(node, "cmdty:id");
          commodityNames.set(id, { name: text(node, "cmdty:name") || id, space: text(node, "cmdty:space") });
        }
      }
      continue;
    }
    if (templateDepth > 0) continue;
    if (stack.length === 0 && !RECORDS.has(name)) continue;
    const node: Node = { name, text: "", children: [] };
    if (stack.length) stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  // Accounts, keeping only those under the book's root.
  interface RawAccount {
    guid: string;
    name: string;
    type: string;
    parent: string;
    commodity: string;
    placeholder: boolean;
    hidden: boolean;
  }
  const raw: RawAccount[] = accountNodes.map((n) => {
    const slots = child(n, "act:slots");
    return {
      guid: text(n, "act:id"),
      name: text(n, "act:name"),
      type: text(n, "act:type"),
      parent: text(n, "act:parent"),
      commodity: text(n, "act:commodity", "cmdty:id"),
      placeholder: text(slot(slots, "placeholder"), "slot:value") === "true",
      hidden: text(slot(slots, "hidden"), "slot:value") === "true",
    };
  });
  const root = raw.find((a) => a.type === "ROOT");
  if (!root) throw new BookError("The book has no root account.");
  const byGuid = new Map(raw.map((a) => [a.guid, a]));
  const paths = new Map<string, string | null>();
  const pathOf = (guid: string, seen = new Set<string>()): string | null => {
    if (guid === root.guid) return "";
    if (paths.has(guid)) return paths.get(guid)!;
    const a = byGuid.get(guid);
    if (!a || !a.parent || seen.has(guid)) return null;
    seen.add(guid);
    const parent = pathOf(a.parent, seen);
    const path = parent === null ? null : parent ? `${parent}:${a.name}` : a.name;
    paths.set(guid, path);
    return path;
  };
  const accounts: GncAccount[] = [];
  for (const a of raw) {
    if (a.guid === root.guid) continue;
    const path = pathOf(a.guid);
    if (path === null) continue;
    const info = commodityNames.get(a.commodity);
    accounts.push({
      guid: a.guid,
      name: a.name,
      path,
      type: a.type,
      parentGuid: a.parent === root.guid ? null : a.parent,
      commodity: a.commodity,
      commodityName: info?.name ?? "",
      commodityNamespace: info?.space ?? "",
      placeholder: a.placeholder,
      hidden: a.hidden,
    });
  }
  accounts.sort((a, b) => a.path.localeCompare(b.path));
  const inBook = new Set(accounts.map((a) => a.guid));

  // Transactions; any that touch an account outside the book are templates and are dropped.
  const currencyCount = new Map<string, number>();
  const transactions: GncTransaction[] = [];
  for (const n of txNodes) {
    const splits: GncSplit[] = [];
    let outside = false;
    for (const s of child(n, "trn:splits")?.children ?? []) {
      if (s.name !== "trn:split") continue;
      const account = text(s, "split:account");
      if (!inBook.has(account)) {
        outside = true;
        break;
      }
      const [vn, vd] = rational(text(s, "split:value"));
      const [qn, qd] = rational(text(s, "split:quantity"));
      splits.push({
        guid: text(s, "split:id"),
        accountGuid: account,
        memo: text(s, "split:memo"),
        reconcile: text(s, "split:reconciled-state") || "n",
        value: rationalToCents(vn, vd),
        quantity: rationalToCents(qn, qd),
        shares: rationalToMicros(qn, qd),
      });
    }
    if (outside || splits.length === 0) continue;
    const slots = child(n, "trn:slots");
    const currency = text(n, "trn:currency", "cmdty:id");
    currencyCount.set(currency, (currencyCount.get(currency) ?? 0) + 1);
    transactions.push({
      guid: text(n, "trn:id"),
      date: postedDate(
        text(n, "trn:date-posted", "ts:date"),
        text(child(slot(slots, "date-posted"), "slot:value"), "gdate"),
      ),
      num: text(n, "trn:num"),
      description: text(n, "trn:description"),
      notes: text(slot(slots, "notes"), "slot:value"),
      currency,
      splits,
    });
  }
  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.guid.localeCompare(b.guid)));
  const currency = [...currencyCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";

  const prices: GncPrice[] = [];
  for (const p of priceNodes) {
    const [vn, vd] = rational(text(p, "price:value"));
    const commodity = text(p, "price:commodity", "cmdty:id");
    const cur = text(p, "price:currency", "cmdty:id");
    const ts = text(p, "price:time", "ts:date");
    if (!commodity || !cur || !ts || !vd) continue;
    prices.push({ commodity, currency: cur, date: postedDate(ts, ""), value: rationalToMicros(vn, vd) });
  }

  return { currency, accounts, transactions, prices };
}
