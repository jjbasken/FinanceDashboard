import {
  INVESTMENT_ACTION_LABELS,
  priceFromValue,
  type AccountType,
  type GnucashBalanceCheck,
  type GnucashMapping,
  type GnucashPreview,
  type SecurityType,
} from "@fd/shared";
import type { GncAccount, GncBook, GncSplit, GncTransaction } from "./read";

/** What already exists in the household, for suggestions and validation. */
export interface ImportContext {
  accounts: { id: number; name: string; onBudget: boolean; balance: number }[];
  categories: { id: number; name: string; groupName: string; isIncome: boolean }[];
  /** GnuCash transaction GUIDs an earlier import already brought in. */
  imported: Set<string>;
  /** Mappings used by the last import, keyed by GnuCash account GUID. */
  remembered: Map<string, GnucashMapping>;
  securities: { id: number; symbol: string; name: string }[];
  /** importedIds of investment transactions already brought in. */
  importedInvestments: Set<string>;
}

export type AccountRef = { kind: "existing"; id: number } | { kind: "new"; key: string };
export type CategoryRef =
  { kind: "existing"; id: number } | { kind: "new"; key: string } | { kind: "startingBalances" };

export interface NewAccount {
  key: string;
  gnucashGuid: string;
  name: string;
  type: AccountType;
  onBudget: boolean;
}

export interface NewCategory {
  key: string;
  groupName: string;
  name: string;
  isIncome: boolean;
}

export interface PlannedChild {
  importedId: string;
  amount: number;
  category: CategoryRef | null;
  notes: string;
}

export interface PlannedRow {
  importedId: string;
  account: AccountRef;
  date: string;
  amount: number;
  payeeName: string | null;
  category: CategoryRef | null;
  notes: string;
  cleared: boolean;
  reconciled: boolean;
  /** Non-empty for a split transaction. */
  children: PlannedChild[];
}

export type SecurityRef = { kind: "existing"; id: number } | { kind: "new"; key: string };

export interface NewSecurity {
  /** The upper-case symbol. */
  key: string;
  symbol: string;
  name: string;
  type: SecurityType;
  /** Only real tickers get daily prices; named funds (common in 401k plans) don't have one. */
  autoPrice: boolean;
}

export interface PlannedInvestment {
  importedId: string;
  account: AccountRef;
  security: SecurityRef;
  date: string;
  action: "buy" | "sell" | "split";
  /** Signed micro-shares. */
  shares: number;
  price: number;
  /** Cost or proceeds, in cents. */
  amount: number;
  /** Cash moving in (+) or out (-) of the account; 0 for splits. */
  cash: number;
  payeeName: string;
  notes: string;
  cleared: boolean;
}

export interface PlannedPrice {
  security: SecurityRef;
  date: string;
  close: number;
}

export interface PlannedTransaction {
  guid: string;
  rows: PlannedRow[];
  /** Pairs of rows that become the two sides of a transfer. */
  transfers: [PlannedRow, PlannedRow][];
  investments: PlannedInvestment[];
}

export interface Plan {
  newAccounts: NewAccount[];
  newCategories: NewCategory[];
  newSecurities: NewSecurity[];
  transactions: PlannedTransaction[];
  prices: PlannedPrice[];
  preview: GnucashPreview;
}

/** Thrown for mappings that don't make sense; the message is shown to the user. */
export class MappingError extends Error {}

const SKIPPED_BY_DEFAULT = /^(Imbalance|Orphan)-/;
const HOLDING_TYPES = new Set(["STOCK", "MUTUAL"]);

const lower = (s: string) => s.trim().toLowerCase();
const accountKey = (ref: AccountRef) => (ref.kind === "existing" ? `e${ref.id}` : `n${ref.key}`);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Expenses:Auto:Fuel -> group "Auto", category "Fuel"; Expenses:Groceries -> group "Expenses". */
function categoryNames(account: GncAccount) {
  const [top = account.name, ...rest] = account.path.split(":");
  if (rest.length === 0) return { groupName: top, name: top };
  if (rest.length === 1) return { groupName: top, name: rest[0]! };
  return { groupName: rest[0]!, name: rest.slice(1).join(": ") };
}

/** A commodity mnemonic that is a usable ticker (e.g. VTI, FCNTX, BRK-B), not a fund's name. */
export function isTicker(mnemonic: string) {
  return /^[A-Za-z0-9][A-Za-z0-9.\-^=]{0,9}$/.test(mnemonic);
}

/**
 * The symbol for a holding: its ticker, or for a named fund without one (e.g. "SP TTL MRKT IDX
 * CL F"), short initials ("STMICF"). Clipping long names instead would make different funds
 * that share a long prefix collide.
 */
function symbolFor(account: GncAccount) {
  if (isTicker(account.commodity)) return account.commodity.toUpperCase();
  const words = (account.commodityName || account.commodity || account.name).toUpperCase().split(/[^A-Z0-9]+/);
  const initials = words
    .filter(Boolean)
    .map((w) => (/\d/.test(w) ? w : w[0]))
    .join("");
  return initials.slice(0, 16) || "FUND";
}

function suggestDefault(account: GncAccount, book: GncBook, ctx: ImportContext): GnucashMapping {
  if (SKIPPED_BY_DEFAULT.test(account.name)) return { kind: "skip" };
  const asAccount = (type: AccountType, onBudget: boolean): GnucashMapping => {
    const existing = ctx.accounts.find((a) => lower(a.name) === lower(account.name));
    return { kind: "account", accountId: existing?.id ?? null, name: clip(account.name, 100), type, onBudget };
  };
  const holdsShares = book.accounts.some((a) => a.parentGuid === account.guid && HOLDING_TYPES.has(a.type));

  switch (account.type) {
    case "BANK":
      return asAccount(/saving/i.test(account.name) ? "savings" : "checking", true);
    case "CASH":
      return asAccount("cash", true);
    case "CREDIT":
      return asAccount("credit", true);
    case "ASSET":
    case "RECEIVABLE":
      return asAccount(holdsShares ? "investment" : "asset", false);
    case "LIABILITY":
    case "PAYABLE":
      return asAccount("loan", false);
    case "INCOME":
    case "EXPENSE": {
      const isIncome = account.type === "INCOME";
      const { groupName, name } = categoryNames(account);
      const sameKind = ctx.categories.filter((c) => c.isIncome === isIncome);
      const exact = sameKind.find((c) => lower(c.groupName) === lower(groupName) && lower(c.name) === lower(name));
      const byName = sameKind.filter((c) => lower(c.name) === lower(name));
      const match = exact ?? (byName.length === 1 ? byName[0] : undefined);
      return {
        kind: "category",
        categoryId: match?.id ?? null,
        groupName: clip(groupName, 100),
        name: clip(name, 100),
        isIncome,
      };
    }
    case "EQUITY":
      return { kind: "opening" };
    case "STOCK":
    case "MUTUAL": {
      const symbol = symbolFor(account);
      // Made-up symbols could clash with a real ticker, so named funds only match by name.
      const existing = isTicker(account.commodity)
        ? ctx.securities.find((x) => x.symbol === symbol)
        : ctx.securities.find((x) => lower(x.name) === lower(account.commodityName || account.name));
      const fund = account.type === "MUTUAL" || /fund/i.test(account.commodityNamespace);
      return {
        kind: "holding",
        securityId: existing?.id ?? null,
        symbol,
        name: clip(account.commodityName || account.name, 120),
        type: fund ? "mutual_fund" : "stock",
      };
    }
    default:
      // TRADING and other bookkeeping accounts.
      return { kind: "skip" };
  }
}

/** Is a remembered mapping still valid (its target not deleted)? */
function stillValid(m: GnucashMapping, ctx: ImportContext) {
  if (m.kind === "account" && m.accountId !== null) return ctx.accounts.some((a) => a.id === m.accountId);
  if (m.kind === "category" && m.categoryId !== null) return ctx.categories.some((c) => c.id === m.categoryId);
  if (m.kind === "holding" && m.securityId !== null) return ctx.securities.some((x) => x.id === m.securityId);
  return true;
}

export function suggestMappings(book: GncBook, ctx: ImportContext) {
  const out = new Map<string, { mapping: GnucashMapping; remembered: boolean }>();
  for (const account of book.accounts) {
    const remembered = ctx.remembered.get(account.guid);
    // Holdings were always skipped before investments existed; that wasn't a choice to keep.
    const forcedSkip = remembered?.kind === "skip" && HOLDING_TYPES.has(account.type);
    if (remembered && !forcedSkip && stillValid(remembered, ctx))
      out.set(account.guid, { mapping: remembered, remembered: true });
    else out.set(account.guid, { mapping: suggestDefault(account, book, ctx), remembered: false });
  }
  // Different holdings must not end up sharing a new security's symbol.
  const taken = new Map<string, string>();
  for (const [guid, s] of out) {
    const m = s.mapping;
    if (m.kind !== "holding" || m.securityId !== null || s.remembered) continue;
    let symbol = m.symbol;
    for (let n = 2; taken.has(symbol) && taken.get(symbol) !== m.name; n++) symbol = `${m.symbol}-${n}`;
    taken.set(symbol, m.name);
    if (symbol !== m.symbol) out.set(guid, { ...s, mapping: { ...m, symbol } });
  }
  return out;
}

/** The amount a split moves in its account: its quantity when that's in the transaction's currency. */
function amountIn(split: GncSplit, account: GncAccount, tx: GncTransaction) {
  return account.commodity === tx.currency ? split.quantity : split.value;
}

export function planImport(book: GncBook, input: Record<string, GnucashMapping>, ctx: ImportContext): Plan {
  const suggestions = suggestMappings(book, ctx);
  const accountsByGuid = new Map(book.accounts.map((a) => [a.guid, a]));
  const mappingOf = (guid: string) => input[guid] ?? suggestions.get(guid)!.mapping;
  const warnings: string[] = [];

  for (const guid of Object.keys(input)) {
    if (!accountsByGuid.has(guid)) throw new MappingError("The mapping mentions an account that isn't in this book");
  }

  // Resolve every GnuCash account to an account ref, a category ref, or neither.
  const newAccounts: NewAccount[] = [];
  const newCategories = new Map<string, NewCategory>();
  const accountRef = new Map<string, AccountRef>();
  const categoryRef = new Map<string, CategoryRef>();
  const onBudget = new Map<string, boolean>();
  const accountNames = new Map<string, string>();
  for (const a of ctx.accounts) {
    onBudget.set(`e${a.id}`, a.onBudget);
    accountNames.set(`e${a.id}`, a.name);
  }

  // Empty accounts (usually placeholders) never create anything...
  const used = new Set(book.transactions.flatMap((t) => t.splits.map((s) => s.accountGuid)));

  // ...except the account a holding lives in: the nearest ancestor imported as an account.
  const holdingHome = new Map<string, string>();
  for (const account of book.accounts) {
    if (!used.has(account.guid) || mappingOf(account.guid).kind !== "holding") continue;
    let parent = account.parentGuid;
    while (parent && mappingOf(parent).kind !== "account") parent = accountsByGuid.get(parent)?.parentGuid ?? null;
    if (parent) {
      holdingHome.set(account.guid, parent);
      used.add(parent);
    } else {
      warnings.push(
        `${account.path} is a holding, but none of the accounts above it is imported as an account, so it's skipped.`,
      );
    }
  }
  const newSecurities = new Map<string, NewSecurity>();
  const holdingRef = new Map<string, { account: string; security: SecurityRef; symbol: string }>();

  for (const account of book.accounts) {
    const m = mappingOf(account.guid);
    if (!used.has(account.guid)) continue;
    if (m.kind === "account") {
      if (m.accountId !== null) {
        if (!ctx.accounts.some((a) => a.id === m.accountId)) {
          throw new MappingError(`${account.path} is mapped to an account that no longer exists`);
        }
        accountRef.set(account.guid, { kind: "existing", id: m.accountId });
      } else {
        newAccounts.push({
          key: account.guid,
          gnucashGuid: account.guid,
          name: m.name,
          type: m.type,
          onBudget: m.onBudget,
        });
        accountRef.set(account.guid, { kind: "new", key: account.guid });
        onBudget.set(`n${account.guid}`, m.onBudget);
        accountNames.set(`n${account.guid}`, m.name);
      }
      if (account.commodity && account.commodity !== book.currency) {
        warnings.push(
          `${account.path} holds ${account.commodity}, not ${book.currency}. Its transactions are imported at their ${book.currency} value.`,
        );
      }
    } else if (m.kind === "holding" && holdingHome.has(account.guid)) {
      let security: SecurityRef;
      if (m.securityId !== null) {
        if (!ctx.securities.some((x) => x.id === m.securityId)) {
          throw new MappingError(`${account.path} is mapped to a security that no longer exists`);
        }
        security = { kind: "existing", id: m.securityId };
      } else {
        const existing = ctx.securities.find((x) => x.symbol === m.symbol);
        if (existing) security = { kind: "existing", id: existing.id };
        else {
          if (!newSecurities.has(m.symbol)) {
            newSecurities.set(m.symbol, {
              key: m.symbol,
              symbol: m.symbol,
              name: m.name,
              type: m.type,
              autoPrice: isTicker(account.commodity) && account.commodity.toUpperCase() === m.symbol,
            });
          }
          security = { kind: "new", key: m.symbol };
        }
      }
      holdingRef.set(account.guid, { account: holdingHome.get(account.guid)!, security, symbol: m.symbol });
    } else if (m.kind === "category") {
      if (m.categoryId !== null) {
        if (!ctx.categories.some((c) => c.id === m.categoryId)) {
          throw new MappingError(`${account.path} is mapped to a category that no longer exists`);
        }
        categoryRef.set(account.guid, { kind: "existing", id: m.categoryId });
      } else {
        // Reuse a category that already exists with this group and name, or one planned already.
        const existing = ctx.categories.find(
          (c) =>
            c.isIncome === m.isIncome && lower(c.groupName) === lower(m.groupName) && lower(c.name) === lower(m.name),
        );
        if (existing) {
          categoryRef.set(account.guid, { kind: "existing", id: existing.id });
        } else {
          const key = `${m.isIncome ? 1 : 0}|${lower(m.groupName)}|${lower(m.name)}`;
          if (!newCategories.has(key)) {
            newCategories.set(key, { key, groupName: m.groupName, name: m.name, isIncome: m.isIncome });
          }
          categoryRef.set(account.guid, { kind: "new", key });
        }
      }
    }
  }

  // Walk the transactions.
  const transactions: PlannedTransaction[] = [];
  let alreadyImported = 0;
  let noAccount = 0;
  let voided = 0;
  let foreign = 0;
  let missingHoldings = 0;
  let investmentCount = 0;
  const skippedUse = new Map<string, number>();
  const rowCounts = { transactions: 0, transfers: 0, splits: 0 };
  const plannedTotals = new Map<string, number>();
  const addTotal = (ref: AccountRef, amount: number) =>
    plannedTotals.set(accountKey(ref), (plannedTotals.get(accountKey(ref)) ?? 0) + amount);

  for (const tx of book.transactions) {
    const splits = tx.splits.filter((s) => s.value !== 0 || s.quantity !== 0);
    if (splits.length === 0) {
      voided++;
      continue;
    }
    if (ctx.imported.has(tx.guid)) {
      alreadyImported++;
      const holdingSplits = splits.filter((s) => holdingRef.has(s.accountGuid) && s.shares !== 0);
      if (holdingSplits.some((s) => !ctx.importedInvestments.has(`gnucash:${tx.guid}:${s.guid}`))) missingHoldings++;
      continue;
    }
    if (tx.currency !== book.currency) foreign++;

    // Group the splits that land in our accounts by destination account.
    // A holding split counts as cash arriving in (or leaving) its account, which a buy or sell
    // then turns into shares. Zero-share holding splits are GnuCash's realized-gain bookkeeping.
    const groups = new Map<string, { ref: AccountRef; splits: GncSplit[]; total: number }>();
    const others: GncSplit[] = [];
    const holdingSplits: GncSplit[] = [];
    let realizedGain = false;
    const addToGroup = (ref: AccountRef, s: GncSplit, amount: number) => {
      const key = accountKey(ref);
      const g = groups.get(key) ?? { ref, splits: [], total: 0 };
      g.splits.push(s);
      g.total += amount;
      groups.set(key, g);
    };
    for (const s of splits) {
      const holding = holdingRef.get(s.accountGuid);
      if (holding) {
        if (s.shares === 0) {
          realizedGain = true;
          continue;
        }
        holdingSplits.push(s);
        addToGroup(accountRef.get(holding.account)!, s, s.value);
        continue;
      }
      const ref = accountRef.get(s.accountGuid);
      if (!ref) others.push(s);
      else addToGroup(ref, s, amountIn(s, accountsByGuid.get(s.accountGuid)!, tx));
    }
    if (groups.size === 0) {
      noAccount++;
      continue;
    }

    // The primary account carries the categories: prefer an on-budget account, then the biggest move.
    const ordered = [...groups.values()].sort(
      (a, b) =>
        Number(onBudget.get(accountKey(b.ref))) - Number(onBudget.get(accountKey(a.ref))) ||
        Math.abs(b.total) - Math.abs(a.total),
    );
    const primary = ordered[0]!;
    const primaryOnBudget = onBudget.get(accountKey(primary.ref)) ?? false;
    const status = (s: GncSplit) => ({
      cleared: s.reconcile === "c" || s.reconcile === "y" || s.reconcile === "f",
      reconciled: s.reconcile === "y" || s.reconcile === "f",
    });
    const join = (...parts: string[]) =>
      clip(
        parts
          .map((p) => p.trim())
          .filter(Boolean)
          .join(" · "),
        1000,
      );
    const num = tx.num.trim() ? `#${tx.num.trim()}` : "";
    const payeeName = tx.description.trim() ? clip(tx.description.trim(), 100) : null;
    const prefix = `gnucash:${tx.guid}:`;

    const planned: PlannedTransaction = { guid: tx.guid, rows: [], transfers: [], investments: [] };

    for (const s of holdingSplits) {
      const holding = holdingRef.get(s.accountGuid)!;
      const action = s.value === 0 ? "split" : s.shares > 0 ? "buy" : "sell";
      const investment: PlannedInvestment = {
        importedId: `${prefix}${s.guid}`,
        account: accountRef.get(holding.account)!,
        security: holding.security,
        date: tx.date,
        action,
        shares: s.shares,
        price: s.value ? priceFromValue(s.value, s.shares) : 0,
        amount: Math.abs(s.value),
        cash: -s.value,
        payeeName: payeeName ?? `${INVESTMENT_ACTION_LABELS[action]} ${holding.symbol}`,
        notes: join(num, s.memo, tx.notes),
        cleared: status(s).cleared,
      };
      planned.investments.push(investment);
      addTotal(investment.account, investment.cash);
      investmentCount++;
    }

    // An opening-balance entry often seeds several accounts against Equity at once. Give each
    // account its own starting balance rather than transfers between them.
    if (
      others.length > 0 &&
      ordered.length > 1 &&
      holdingSplits.length === 0 &&
      others.every((s) => mappingOf(s.accountGuid).kind === "opening")
    ) {
      for (const g of ordered) {
        const first = g.splits[0]!;
        const budgeted = onBudget.get(accountKey(g.ref)) ?? false;
        planned.rows.push({
          importedId: `${prefix}${first.guid}`,
          account: g.ref,
          date: tx.date,
          amount: g.total,
          payeeName: "Starting Balance",
          category: budgeted ? { kind: "startingBalances" } : null,
          notes: join(num, ...g.splits.map((s) => s.memo), tx.notes),
          ...status(first),
          children: [],
        });
        addTotal(g.ref, g.total);
        rowCounts.transactions++;
      }
      transactions.push(planned);
      continue;
    }

    // Every other account gets a transfer with the primary.
    for (const g of ordered.slice(1)) {
      const first = g.splits[0]!;
      const notes = join(num, tx.description, ...g.splits.map((s) => s.memo), tx.notes);
      const from: PlannedRow = {
        importedId: `${prefix}${first.guid}:from`,
        account: primary.ref,
        date: tx.date,
        amount: -g.total,
        payeeName: null,
        category: null,
        notes,
        ...status(primary.splits[0]!),
        children: [],
      };
      const to: PlannedRow = {
        importedId: `${prefix}${first.guid}`,
        account: g.ref,
        date: tx.date,
        amount: g.total,
        payeeName: null,
        category: null,
        notes,
        ...status(first),
        children: [],
      };
      planned.transfers.push([from, to]);
      addTotal(primary.ref, from.amount);
      addTotal(g.ref, to.amount);
      rowCounts.transfers++;
    }

    // What's left on the primary account is explained by categories, opening balances and skipped accounts.
    const remaining = primary.total + ordered.slice(1).reduce((sum, g) => sum + g.total, 0);
    const children: PlannedChild[] = others.map((s) => {
      const account = accountsByGuid.get(s.accountGuid)!;
      const mapping = mappingOf(s.accountGuid);
      let category: CategoryRef | null = null;
      let note = s.memo;
      if (mapping.kind === "category") category = categoryRef.get(s.accountGuid)!;
      else if (mapping.kind === "opening") category = primaryOnBudget ? { kind: "startingBalances" } : null;
      else {
        note = join(s.memo, `GnuCash: ${account.path}`);
        skippedUse.set(account.path, (skippedUse.get(account.path) ?? 0) + 1);
      }
      return { importedId: `${prefix}${s.guid}`, amount: -s.value, category, notes: clip(note, 1000) };
    });
    const explained = children.reduce((sum, c) => sum + c.amount, 0);
    if (explained !== remaining) {
      // Currency conversions can leave a few cents unexplained; keep the books balanced.
      children.push({
        importedId: `${prefix}imbalance`,
        amount: remaining - explained,
        category: null,
        notes: realizedGain ? "Offsets GnuCash's realized-gain entry" : "Unbalanced in GnuCash",
      });
    }

    if (children.length > 0) {
      const single = children.length === 1 ? children[0]! : null;
      const isOpening = others.length > 0 && others.every((s) => mappingOf(s.accountGuid).kind === "opening");
      planned.rows.push({
        importedId: `${prefix}${primary.splits[0]!.guid}`,
        account: primary.ref,
        date: tx.date,
        amount: remaining,
        payeeName: isOpening ? "Starting Balance" : payeeName,
        category: single ? single.category : null,
        notes: join(num, ...primary.splits.map((s) => s.memo), single?.notes ?? "", tx.notes),
        ...status(primary.splits[0]!),
        children: single ? [] : children,
      });
      addTotal(primary.ref, remaining);
      rowCounts.transactions++;
      if (!single) rowCounts.splits += children.length;
    }

    if (planned.rows.length || planned.transfers.length || planned.investments.length) transactions.push(planned);
  }

  // Price history for the imported securities, in the book's currency.
  const plannedPrices: PlannedPrice[] = [];
  const seenPrices = new Set<string>();
  const securityByCommodity = new Map<string, SecurityRef>();
  for (const [guid, h] of holdingRef) securityByCommodity.set(accountsByGuid.get(guid)!.commodity, h.security);
  for (const p of book.prices) {
    const security = securityByCommodity.get(p.commodity);
    if (!security || p.currency !== book.currency || p.value <= 0) continue;
    const key = `${security.kind}${security.kind === "existing" ? security.id : security.key}|${p.date}`;
    if (seenPrices.has(key)) continue;
    seenPrices.add(key);
    plannedPrices.push({ security, date: p.date, close: p.value });
  }

  // Compare each destination account's balance with GnuCash's.
  const gnucashTotals = new Map<string, number>();
  for (const tx of book.transactions) {
    for (const s of tx.splits) {
      const ref = accountRef.get(s.accountGuid);
      if (!ref) continue;
      const k = accountKey(ref);
      gnucashTotals.set(k, (gnucashTotals.get(k) ?? 0) + amountIn(s, accountsByGuid.get(s.accountGuid)!, tx));
    }
  }
  const balances: GnucashBalanceCheck[] = [...gnucashTotals.keys()].map((k) => {
    const existing = k.startsWith("e") ? ctx.accounts.find((a) => `e${a.id}` === k) : undefined;
    return {
      name: accountNames.get(k) ?? "",
      accountId: existing?.id ?? null,
      gnucash: gnucashTotals.get(k)!,
      afterImport: (existing?.balance ?? 0) + (plannedTotals.get(k) ?? 0),
    };
  });
  balances.sort((a, b) => a.name.localeCompare(b.name));

  for (const [path, n] of [...skippedUse].sort((a, b) => b[1] - a[1])) {
    warnings.push(
      `${path} is skipped. Its share of ${n} transaction${n === 1 ? "" : "s"} is imported as uncategorized.`,
    );
  }
  if (missingHoldings) {
    warnings.push(
      `${missingHoldings} transaction${missingHoldings === 1 ? " was" : "s were"} imported before investment support, so ${missingHoldings === 1 ? "its" : "their"} shares are missing. To bring them in, undo that earlier import and import the book again.`,
    );
  }
  if (foreign) {
    warnings.push(
      `${foreign} transaction${foreign === 1 ? " is" : "s are"} in a currency other than ${book.currency}.`,
    );
  }

  return {
    newAccounts,
    newCategories: [...newCategories.values()],
    newSecurities: [...newSecurities.values()],
    transactions,
    prices: plannedPrices,
    preview: {
      transactions: transactions.length,
      alreadyImported,
      noAccount,
      voided,
      rows: rowCounts,
      investments: investmentCount,
      prices: plannedPrices.length,
      newSecurities: [...newSecurities.values()].map((x) => x.symbol),
      newAccounts: newAccounts.map((a) => a.name),
      newCategories: [...newCategories.values()].map((c) => `${c.groupName}: ${c.name}`),
      warnings,
      balances,
    },
  };
}
