import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { INVESTMENT_ACTION_LABELS } from "@fd/shared";
import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "../db";
import {
  accounts,
  categories,
  categoryGroups,
  households,
  investmentTxns,
  payees,
  prices,
  securities,
  transactions,
} from "../db/schema";
import { STARTING_BALANCES } from "../services/household";
import { canSee, type Actor } from "../services/ledger";

/**
 * Write the household's books as a GnuCash file (compressed XML, GnuCash's default format), so
 * the data can be moved back to GnuCash. It's the reverse of the GnuCash importer:
 *
 * - Accounts go under Assets or Liabilities; investment accounts hold one STOCK or MUTUAL account
 *   per security, and their buys, sells, dividends and splits become share transactions.
 * - Categories become Income:<group>:<category> and Expenses:<group>:<category> (a group named
 *   "Income" or "Expenses" is left out of the path), and Starting Balances becomes
 *   Equity:Opening Balances.
 * - Uncategorized money goes to Imbalance-<currency>, as GnuCash itself does.
 * - Only accounts the member can see are included; a transfer to someone else's private account
 *   goes to Imbalance.
 *
 * Budgets, recurring bills and sidebar folders have no GnuCash equivalent here and are left out.
 */

const guid = () => randomUUID().replaceAll("-", "");

// XML 1.0 cannot encode control characters or lone UTF-16 surrogates, even as entities.
const xmlText = (s: string) => s.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "�");
const esc = (s: string) =>
  xmlText(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** GnuCash separates account paths with ":", so it can't appear in a name. */
const accountName = (s: string) => xmlText(s).replaceAll(":", "-").trim() || "Unnamed";

/** A posted date the way GnuCash writes it: 10:59 UTC, which is the same day in every time zone. */
const posted = (date: string) => `${date} 10:59:00 +0000`;
const timestamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19) || "00:00:00"} +0000`;

const cents = (n: number) => `${n}/100`;
const micros = (n: number) => `${n}/1000000`;

interface Commodity {
  space: string;
  id: string;
}

interface GncAccount {
  guid: string;
  name: string;
  type: string;
  parent: string;
  commodity: Commodity;
  scu: number;
  placeholder: boolean;
  hidden: boolean;
}

interface GncSplit {
  account: string;
  /** Cents in the book's currency. */
  value: number;
  /** For share accounts: micro-shares. Otherwise the quantity is the value. */
  shares?: number;
  memo?: string;
  state?: "n" | "c" | "y";
}

interface GncTxn {
  date: string;
  entered: string;
  description: string;
  splits: GncSplit[];
}

const state = (row: { cleared: boolean; reconciled: boolean }) => (row.reconciled ? "y" : row.cleared ? "c" : "n");

export interface GnucashExport {
  bytes: Uint8Array<ArrayBuffer>;
  accounts: number;
  transactions: number;
  prices: number;
}

export function exportGnucash(db: DbOrTx, actor: Actor): GnucashExport {
  const { householdId } = actor;
  const household = db.select().from(households).where(eq(households.id, householdId)).get();
  const currency: Commodity = { space: "ISO4217", id: household?.currency ?? "USD" };

  const book: GncAccount[] = [];
  const root: GncAccount = {
    guid: guid(),
    name: "Root Account",
    type: "ROOT",
    parent: "",
    commodity: currency,
    scu: 100,
    placeholder: false,
    hidden: false,
  };
  book.push(root);

  // Accounts by path, so the same path always gives the same account; parents become placeholders.
  const byPath = new Map<string, GncAccount>();
  const ensure = (
    path: string[],
    type: string,
    opts: { commodity?: Commodity; scu?: number; placeholder?: boolean; hidden?: boolean; parent?: GncAccount } = {},
  ) => {
    let parent = opts.parent ?? root;
    let key = opts.parent ? opts.parent.guid : "";
    path.forEach((part, i) => {
      key += `:${part}`;
      let account = byPath.get(key);
      if (!account) {
        const leaf = i === path.length - 1;
        account = {
          guid: guid(),
          name: part,
          type,
          parent: parent.guid,
          commodity: (leaf && opts.commodity) || currency,
          scu: (leaf && opts.scu) || 100,
          placeholder: leaf ? !!opts.placeholder : true,
          hidden: leaf && !!opts.hidden,
        };
        byPath.set(key, account);
        book.push(account);
      } else if (i === path.length - 1 && !opts.placeholder) {
        // A path used both as a parent and for transactions, e.g. a category named like a group.
        account.placeholder = false;
      }
      parent = account;
    });
    return parent;
  };
  // Two accounts with the same name side by side would be confusing in GnuCash.
  const unique = (parentPath: string[], name: string) => {
    const prefix = `:${parentPath.join(":")}:`;
    let candidate = name;
    for (let n = 2; byPath.has(`${prefix}${candidate}`); n++) candidate = `${name} (${n})`;
    return candidate;
  };

  const imbalance = () => ensure([`Imbalance-${currency.id}`], "BANK");
  const opening = () => ensure(["Equity", "Opening Balances"], "EQUITY");
  let dividendAccount: GncAccount | undefined;
  const dividends = () => dividendAccount ??= ensure(["Income", unique(["Income"], "Dividends")], "INCOME");

  // The member's accounts.
  const accountRows = db
    .select()
    .from(accounts)
    .where(eq(accounts.householdId, householdId))
    .orderBy(asc(accounts.sortOrder), asc(accounts.id))
    .all()
    .filter((a) => canSee(a, actor.userId));
  const accountGuid = new Map<number, GncAccount>();
  for (const a of accountRows) {
    const [top, type] =
      a.type === "checking" || a.type === "savings"
        ? ["Assets", "BANK"]
        : a.type === "cash"
          ? ["Assets", "CASH"]
          : a.type === "credit"
            ? ["Liabilities", "CREDIT"]
            : a.type === "loan"
              ? ["Liabilities", "LIABILITY"]
              : ["Assets", "ASSET"];
    ensure([top], top === "Assets" ? "ASSET" : "LIABILITY", { placeholder: true });
    const name = unique([top], accountName(a.name));
    accountGuid.set(a.id, ensure([top, name], type, { hidden: a.closed }));
  }

  // Categories, in budget order.
  const categoryRows = db
    .select({
      id: categories.id,
      name: categories.name,
      hidden: categories.hidden,
      groupId: categoryGroups.id,
      groupName: categoryGroups.name,
      groupHidden: categoryGroups.hidden,
      isIncome: categoryGroups.isIncome,
    })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(eq(categories.householdId, householdId))
    .orderBy(asc(categoryGroups.sortOrder), asc(categories.sortOrder), asc(categories.id))
    .all();
  // Reserve group paths before adding leaves: a category can have the same name as a group.
  const groupPaths = new Map<number, string[]>();
  for (const c of categoryRows) {
    if (groupPaths.has(c.groupId)) continue;
    const top = c.isIncome ? "Income" : "Expenses";
    ensure([top], c.isIncome ? "INCOME" : "EXPENSE", { placeholder: true });
    const group = accountName(c.groupName);
    const path = group.toLowerCase() === top.toLowerCase()
      ? [top]
      : [top, unique([top], group)];
    ensure(path, c.isIncome ? "INCOME" : "EXPENSE", { placeholder: true });
    groupPaths.set(c.groupId, path);
  }
  const categoryAccount = new Map<number, () => GncAccount>();
  for (const c of categoryRows) {
    if (c.isIncome && c.name === STARTING_BALANCES) {
      categoryAccount.set(c.id, opening);
      continue;
    }
    const path = groupPaths.get(c.groupId)!;
    const account = ensure([...path, unique(path, accountName(c.name))], c.isIncome ? "INCOME" : "EXPENSE", {
      hidden: c.hidden || c.groupHidden,
    });
    categoryAccount.set(c.id, () => account);
  }

  // Securities, and one share account per security in each investment account that trades it.
  const securityRows = db.select().from(securities).where(eq(securities.householdId, householdId)).all();
  const security = new Map(securityRows.map((s) => [s.id, s]));
  const commodityOf = (s: (typeof securityRows)[number]): Commodity => ({
    space: s.type === "mutual_fund" ? "FUND" : "NASDAQ",
    id: s.symbol,
  });
  const holding = (accountId: number, securityId: number) => {
    const s = security.get(securityId)!;
    return ensure([accountName(s.symbol)], s.type === "mutual_fund" ? "MUTUAL" : "STOCK", {
      parent: accountGuid.get(accountId)!,
      commodity: commodityOf(s),
      scu: 1_000_000,
    });
  };

  const payeeRows = db.select().from(payees).where(eq(payees.householdId, householdId)).all();
  const payee = new Map(payeeRows.map((p) => [p.id, p]));
  const description = (payeeId: number | null) => {
    const p = payeeId === null ? undefined : payee.get(payeeId);
    if (!p) return "";
    return p.transferAccountId === null ? p.name : "Transfer";
  };

  const rows = db
    .select()
    .from(transactions)
    .where(eq(transactions.householdId, householdId))
    .orderBy(asc(transactions.date), asc(transactions.id))
    .all();
  const row = new Map(rows.map((r) => [r.id, r]));
  const visible = (r: { accountId: number }) => accountGuid.has(r.accountId);
  const children = new Map<number, typeof rows>();
  for (const r of rows) {
    if (r.parentId === null) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r);
    children.set(r.parentId, list);
  }

  const investmentRows = db
    .select()
    .from(investmentTxns)
    .where(eq(investmentTxns.householdId, householdId))
    .orderBy(asc(investmentTxns.date), asc(investmentTxns.id))
    .all()
    .filter(visible);
  const done = new Set<number>();
  for (const t of investmentRows) if (t.transactionId !== null) done.add(t.transactionId);

  const txns: GncTxn[] = [];

  // The account side of a register row, or of the other side of a transfer.
  const accountSplit = (r: (typeof rows)[number]): GncSplit => ({
    account: accountGuid.get(r.accountId)!.guid,
    value: r.amount,
    memo: r.notes,
    state: state(r),
  });
  const transferSplit = (r: (typeof rows)[number], memo: string): GncSplit => {
    const other = r.transferId === null ? undefined : row.get(r.transferId);
    if (other && visible(other)) {
      done.add(other.id);
      return accountSplit(other);
    }
    return { account: imbalance().guid, value: -r.amount, memo: memo || "Transfer to a private account" };
  };
  const categorySplit = (r: (typeof rows)[number], memo: string): GncSplit => {
    const account =
      r.categoryId !== null
        ? categoryAccount.get(r.categoryId)?.()
        : payee.get(r.payeeId ?? -1)?.name === "Starting Balance"
          ? opening()
          : undefined;
    return { account: (account ?? imbalance()).guid, value: -r.amount, memo };
  };

  for (const r of rows) {
    if (r.parentId !== null || done.has(r.id) || !visible(r)) continue;
    // The other side of a transfer from a split line is written with that split.
    const other = r.transferId === null ? undefined : row.get(r.transferId);
    if (other && other.parentId !== null && visible(other)) continue;
    done.add(r.id);

    const splits = [accountSplit(r)];
    if (r.isParent) {
      for (const c of children.get(r.id) ?? []) {
        splits.push(c.transferId !== null ? transferSplit(c, c.notes) : categorySplit(c, c.notes));
      }
    } else {
      splits.push(r.transferId !== null ? transferSplit(r, "") : categorySplit(r, ""));
    }
    txns.push({ date: r.date, entered: r.createdAt, description: description(r.payeeId), splits });
  }

  for (const t of investmentRows) {
    const s = security.get(t.securityId);
    if (!s) continue;
    const cash = t.transactionId === null ? undefined : row.get(t.transactionId);
    const shares = holding(t.accountId, t.securityId).guid;
    const cashAccount = accountGuid.get(t.accountId)!.guid;
    const cashState = cash ? state(cash) : "n";
    const splits: GncSplit[] = [];
    switch (t.action) {
      case "buy":
      case "sell": {
        const moved = cash?.amount ?? (t.action === "buy" ? -t.amount : t.amount);
        splits.push({ account: cashAccount, value: moved, state: cashState });
        splits.push({ account: shares, value: -moved, shares: t.shares, state: cashState });
        break;
      }
      case "dividend": {
        const received = cash?.amount ?? t.amount;
        splits.push({ account: cashAccount, value: received, state: cashState });
        splits.push({ account: dividends().guid, value: -received });
        break;
      }
      case "reinvest":
        splits.push({ account: shares, value: t.amount, shares: t.shares });
        splits.push({ account: dividends().guid, value: -t.amount });
        break;
      case "transfer_in":
        splits.push({ account: shares, value: t.amount, shares: t.shares });
        if (t.amount) splits.push({ account: opening().guid, value: -t.amount });
        break;
      case "split":
      case "transfer_out":
        splits.push({ account: shares, value: 0, shares: t.shares });
        break;
    }
    if (splits[0]) splits[0].memo = t.notes;
    const name = cash ? description(cash.payeeId) : "";
    txns.push({
      date: t.date,
      entered: t.createdAt,
      description: name || `${INVESTMENT_ACTION_LABELS[t.action]} ${s.symbol}`,
      splits,
    });
  }

  // GnuCash needs every transaction to balance; anything left over goes to Imbalance.
  for (const t of txns) {
    const left = t.splits.reduce((sum, s) => sum + s.value, 0);
    if (left !== 0) t.splits.push({ account: imbalance().guid, value: -left, memo: "Didn't balance when exported" });
  }
  txns.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const priceRows = db
    .select({ securityId: prices.securityId, date: prices.date, close: prices.close })
    .from(prices)
    .innerJoin(securities, eq(securities.id, prices.securityId))
    .where(eq(securities.householdId, householdId))
    .orderBy(asc(prices.securityId), asc(prices.date))
    .all();

  const xml = writeXml({
    currency,
    securities: securityRows.map((s) => ({ ...commodityOf(s), name: s.name })),
    book,
    txns,
    priceRows: priceRows.map((p) => ({ commodity: commodityOf(security.get(p.securityId)!), date: p.date, close: p.close })),
  });
  return {
    bytes: new Uint8Array(gzipSync(new TextEncoder().encode(xml))),
    accounts: book.length - 1,
    transactions: txns.length,
    prices: priceRows.length,
  };
}

const NAMESPACES = [
  "gnc", "act", "book", "cd", "cmdty", "price", "slot", "split", "sx", "trn", "ts", "fs", "bgt", "recurrence",
  "lot", "addr", "billterm", "bt-days", "bt-prox", "cust", "employee", "entry", "invoice", "job", "order", "owner",
  "taxtable", "tte", "vendor",
];

function writeXml(data: {
  currency: Commodity;
  securities: (Commodity & { name: string })[];
  book: GncAccount[];
  txns: GncTxn[];
  priceRows: { commodity: Commodity; date: string; close: number }[];
}) {
  const out: string[] = [];
  const cmdty = (tag: string, c: Commodity) =>
    `<${tag}>\n  <cmdty:space>${esc(c.space)}</cmdty:space>\n  <cmdty:id>${esc(c.id)}</cmdty:id>\n</${tag}>`;
  const slots = (tag: string, entries: [string, string, string][]) =>
    entries.length === 0
      ? ""
      : `<${tag}>\n${entries
          .map(([key, type, value]) =>
            type === "gdate"
              ? `  <slot>\n    <slot:key>${key}</slot:key>\n    <slot:value type="gdate">\n      <gdate>${value}</gdate>\n    </slot:value>\n  </slot>`
              : `  <slot>\n    <slot:key>${key}</slot:key>\n    <slot:value type="${type}">${esc(value)}</slot:value>\n  </slot>`,
          )
          .join("\n")}\n</${tag}>\n`;

  out.push('<?xml version="1.0" encoding="utf-8" ?>');
  out.push(`<gnc-v2\n${NAMESPACES.map((ns) => `     xmlns:${ns}="http://www.gnucash.org/XML/${ns}"`).join("\n")}>`);
  out.push('<gnc:count-data cd:type="book">1</gnc:count-data>');
  out.push('<gnc:book version="2.0.0">');
  out.push(`<book:id type="guid">${guid()}</book:id>`);
  out.push(`<gnc:count-data cd:type="commodity">${data.securities.length + 1}</gnc:count-data>`);
  out.push(`<gnc:count-data cd:type="account">${data.book.length}</gnc:count-data>`);
  out.push(`<gnc:count-data cd:type="transaction">${data.txns.length}</gnc:count-data>`);
  if (data.priceRows.length) out.push(`<gnc:count-data cd:type="price">${data.priceRows.length}</gnc:count-data>`);

  out.push(
    `<gnc:commodity version="2.0.0">\n  <cmdty:space>${data.currency.space}</cmdty:space>\n  <cmdty:id>${esc(data.currency.id)}</cmdty:id>\n  <cmdty:get_quotes/>\n  <cmdty:quote_source>currency</cmdty:quote_source>\n  <cmdty:quote_tz/>\n</gnc:commodity>`,
  );
  for (const s of data.securities) {
    out.push(
      `<gnc:commodity version="2.0.0">\n  <cmdty:space>${esc(s.space)}</cmdty:space>\n  <cmdty:id>${esc(s.id)}</cmdty:id>\n  <cmdty:name>${esc(s.name)}</cmdty:name>\n  <cmdty:fraction>1000000</cmdty:fraction>\n</gnc:commodity>`,
    );
  }

  if (data.priceRows.length) {
    out.push('<gnc:pricedb version="1">');
    for (const p of data.priceRows) {
      out.push(
        [
          '<price>',
          `  <price:id type="guid">${guid()}</price:id>`,
          cmdty("price:commodity", p.commodity),
          cmdty("price:currency", data.currency),
          `  <price:time>\n    <ts:date>${posted(p.date)}</ts:date>\n  </price:time>`,
          "  <price:source>user:price</price:source>",
          "  <price:type>last</price:type>",
          `  <price:value>${micros(p.close)}</price:value>`,
          "</price>",
        ].join("\n"),
      );
    }
    out.push("</gnc:pricedb>");
  }

  for (const a of data.book) {
    const flags: [string, string, string][] = [];
    if (a.hidden) flags.push(["hidden", "string", "true"]);
    if (a.placeholder) flags.push(["placeholder", "string", "true"]);
    out.push(
      [
        '<gnc:account version="2.0.0">',
        `  <act:name>${esc(a.name)}</act:name>`,
        `  <act:id type="guid">${a.guid}</act:id>`,
        `  <act:type>${a.type}</act:type>`,
        cmdty("act:commodity", a.commodity),
        `  <act:commodity-scu>${a.scu}</act:commodity-scu>`,
        slots("act:slots", flags).trimEnd(),
        a.parent ? `  <act:parent type="guid">${a.parent}</act:parent>` : "",
        "</gnc:account>",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  for (const t of data.txns) {
    const splits = t.splits
      .map((s) =>
        [
          "  <trn:split>",
          `    <split:id type="guid">${guid()}</split:id>`,
          s.memo ? `    <split:memo>${esc(s.memo)}</split:memo>` : "",
          `    <split:reconciled-state>${s.state ?? "n"}</split:reconciled-state>`,
          `    <split:value>${cents(s.value)}</split:value>`,
          `    <split:quantity>${s.shares === undefined ? cents(s.value) : micros(s.shares)}</split:quantity>`,
          `    <split:account type="guid">${s.account}</split:account>`,
          "  </trn:split>",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n");
    out.push(
      [
        '<gnc:transaction version="2.0.0">',
        `  <trn:id type="guid">${guid()}</trn:id>`,
        cmdty("trn:currency", data.currency),
        `  <trn:date-posted>\n    <ts:date>${posted(t.date)}</ts:date>\n  </trn:date-posted>`,
        `  <trn:date-entered>\n    <ts:date>${timestamp(t.entered)}</ts:date>\n  </trn:date-entered>`,
        `  <trn:description>${esc(t.description)}</trn:description>`,
        slots("trn:slots", [["date-posted", "gdate", t.date]]).trimEnd(),
        `  <trn:splits>\n${splits}\n  </trn:splits>`,
        "</gnc:transaction>",
      ].join("\n"),
    );
  }

  out.push("</gnc:book>");
  out.push("</gnc-v2>");
  return `${out.join("\n")}\n`;
}
