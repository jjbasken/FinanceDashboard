import {
  centsToInput,
  parseCents,
  type Account,
  type CategoryGroup,
  type Payee,
  type Transaction,
} from "@fd/shared";
import { useMemo } from "react";
import { Link } from "react-router";
import { formatDate, today } from "../ledger";
import type { Option } from "./Autocomplete";

// The register's data model, shared by the desktop table (Register) and the phone list (MobileRegister).

export interface SplitDraft {
  key: number;
  categoryId: number | null;
  /** Move this line to another account, e.g. a loan payment's principal. */
  transferAccountId: number | null;
  notes: string;
  payment: string;
  deposit: string;
}

export interface Draft {
  date: string;
  payeeId: number | null;
  payeeName: string;
  notes: string;
  categoryId: number | null;
  split: boolean;
  splits: SplitDraft[];
  payment: string;
  deposit: string;
  cleared: boolean;
  /** In a private account: count it in the family budget. */
  inBudget: boolean;
}

export type PayeeValue = { id: number | null; name: string };
export type CategoryValue = number | "split";

let splitKey = 0;
/** A fresh key for a split line, unique across drafts. */
export const nextSplitKey = () => ++splitKey;

/** Unsigned cents for the payment/deposit columns, e.g. -1234 -> "12.34". */
export const plain = (cents: number) => centsToInput(Math.abs(cents));

export function amountFields(amount: number) {
  if (amount < 0) return { payment: plain(amount), deposit: "" };
  if (amount > 0) return { payment: "", deposit: plain(amount) };
  return { payment: "", deposit: "" };
}

/** Deposit minus payment, or null if either field isn't a valid amount. */
export function amountOf(f: { payment: string; deposit: string }) {
  const pay = f.payment.trim() ? parseCents(f.payment) : 0;
  const dep = f.deposit.trim() ? parseCents(f.deposit) : 0;
  if (pay === null || dep === null) return null;
  return dep - pay;
}

export function blankDraft(date = today()): Draft {
  return {
    date,
    payeeId: null,
    payeeName: "",
    notes: "",
    categoryId: null,
    split: false,
    splits: [],
    payment: "",
    deposit: "",
    cleared: false,
    inBudget: false,
  };
}

export function draftFrom(t: Transaction, payeeName: string): Draft {
  return {
    date: t.date,
    payeeId: t.payeeId,
    payeeName,
    notes: t.notes,
    categoryId: t.categoryId,
    split: t.splits.length > 0,
    splits: t.splits.map((s) => ({
      key: nextSplitKey(),
      categoryId: s.categoryId,
      transferAccountId: s.transferAccountId,
      notes: s.notes,
      ...amountFields(s.amount),
    })),
    ...amountFields(t.amount),
    cleared: t.cleared,
    inBudget: t.inBudget,
  };
}

export type Built = { error: string } | { error: null; body: Record<string, unknown> };

/** Validate a draft and turn it into an API body; with `original`, only the changed fields. */
export function buildBody(d: Draft, original?: Draft): Built {
  if (!d.date) return { error: "Enter a date" };
  const amount = amountOf(d);
  if (amount === null) return { error: "Enter amounts as numbers, like 12.34" };

  const splits = d.split
    ? d.splits.map((s) => ({
        amount: amountOf(s),
        categoryId: s.categoryId,
        transferAccountId: s.transferAccountId,
        notes: s.notes.trim(),
      }))
    : [];
  if (splits.some((s) => s.amount === null)) return { error: "Enter split amounts as numbers, like 12.34" };
  if (d.split && splits.reduce((sum, s) => sum + s.amount!, 0) !== amount) {
    return { error: "The splits must add up to the transaction amount" };
  }

  const payee =
    d.payeeId != null
      ? { payeeId: d.payeeId }
      : d.payeeName.trim()
        ? { payeeName: d.payeeName.trim() }
        : { payeeId: null };
  const full: Record<string, unknown> = {
    date: d.date,
    amount,
    ...payee,
    notes: d.notes.trim(),
    categoryId: d.split ? null : d.categoryId,
    cleared: d.cleared,
    inBudget: d.inBudget,
    splits,
  };
  if (!original) return { error: null, body: full };

  const before = buildBody(original);
  if (before.error !== null) return { error: null, body: full };
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    if (k === "payeeId" || k === "payeeName") continue;
    if (JSON.stringify(v) !== JSON.stringify(before.body[k])) body[k] = v;
  }
  if (d.payeeId !== original.payeeId || (d.payeeId == null && d.payeeName.trim() !== original.payeeName.trim())) {
    Object.assign(body, payee);
  }
  // Splits have to travel with the amount they add up to.
  if (body.amount !== undefined && (d.split || original.split)) body.splits = splits;
  if (body.splits !== undefined) body.amount = amount;
  return { error: null, body };
}

export interface Lookups {
  account: Account;
  accounts: Account[];
  payeeById: Map<number, Payee>;
  payeeOptions: Option<PayeeValue>[];
  categoryName: Map<number, string>;
  categoryOptions: Option<CategoryValue>[];
  splitCategoryOptions: Option<CategoryValue>[];
  /** Accounts a split line can transfer to. */
  transferOptions: Option<number>[];
}

export function payeeLabel(p: Payee | undefined) {
  if (!p) return "";
  return p.transferAccountId ? `Transfer: ${p.name}` : p.name;
}

/** Marks a row that a recurring bill added. */
export function BillMark() {
  return (
    <span className="bill-mark" title="From a recurring bill" aria-label="From a recurring bill">
      ↻
    </span>
  );
}

/** A private account whose transactions can be counted in the family budget one by one. */
export const choosesBudget = (account: Account) => account.private && account.onBudget;

/** Transfers between two on-budget accounts don't take a category. */
export function isBudgetTransfer(l: Lookups, payeeId: number | null) {
  return isBudgetTransferTo(l, payeeId != null ? l.payeeById.get(payeeId)?.transferAccountId : null);
}

export function isBudgetTransferTo(l: Lookups, accountId: number | null | undefined) {
  if (!accountId) return false;
  return l.account.onBudget && !!l.accounts.find((a) => a.id === accountId)?.onBudget;
}

export function transferLabel(l: Lookups, accountId: number | null) {
  if (accountId == null) return "";
  return `Transfer: ${l.accounts.find((a) => a.id === accountId)?.name ?? ""}`;
}

export function useLookups(account: Account, accounts: Account[], payees: Payee[], groups: CategoryGroup[]): Lookups {
  return useMemo(() => {
    const payeeById = new Map(payees.map((p) => [p.id, p]));
    const open = new Set(accounts.filter((a) => !a.closed).map((a) => a.id));
    const regular = payees.filter((p) => !p.transferAccountId);
    const transfers = payees.filter(
      (p) => p.transferAccountId && p.transferAccountId !== account.id && open.has(p.transferAccountId),
    );
    const payeeOptions: Option<PayeeValue>[] = [
      ...regular.map((p) => ({ key: `p${p.id}`, label: p.name, value: { id: p.id, name: p.name }, group: "Payees" })),
      ...transfers.map((p) => ({
        key: `p${p.id}`,
        label: payeeLabel(p),
        value: { id: p.id, name: p.name },
        group: "Transfer to/from",
      })),
    ];

    const categoryName = new Map<number, string>();
    const splitCategoryOptions: Option<CategoryValue>[] = [];
    for (const g of groups) {
      for (const c of g.categories) {
        categoryName.set(c.id, c.name);
        if (!g.hidden && !c.hidden)
          splitCategoryOptions.push({ key: `c${c.id}`, label: c.name, value: c.id, group: g.name });
      }
    }
    const categoryOptions: Option<CategoryValue>[] = [
      { key: "split", label: "Split transaction", value: "split" },
      ...splitCategoryOptions,
    ];
    const transferOptions: Option<number>[] = transfers.map((p) => ({
      key: `a${p.transferAccountId}`,
      label: payeeLabel(p),
      value: p.transferAccountId!,
    }));
    return {
      account,
      accounts,
      payeeById,
      payeeOptions,
      categoryName,
      categoryOptions,
      splitCategoryOptions,
      transferOptions,
    };
  }, [account, accounts, payees, groups]);
}

export const createPayee = (text: string): Option<PayeeValue> => ({
  key: "create",
  label: `Create payee “${text}”`,
  value: { id: null, name: text },
});


/** The amount still to assign across a split's lines. */
export function remainingOf(d: Draft) {
  const amount = amountOf(d);
  return d.split && amount !== null ? amount - d.splits.reduce((sum, s) => sum + (amountOf(s) ?? 0), 0) : 0;
}

/** Turn a plain draft into a split: its category and amount become the first line. */
export function startSplit(d: Draft): Partial<Draft> {
  const first: SplitDraft = {
    key: nextSplitKey(),
    categoryId: d.categoryId,
    transferAccountId: null,
    notes: "",
    payment: d.payment,
    deposit: d.deposit,
  };
  return {
    split: true,
    categoryId: null,
    splits: [
      first,
      { key: nextSplitKey(), categoryId: null, transferAccountId: null, notes: "", payment: "", deposit: "" },
    ],
  };
}

/** A new split line holding whatever is left to assign. */
export function newSplitLine(d: Draft): SplitDraft {
  return { key: nextSplitKey(), categoryId: null, transferAccountId: null, notes: "", ...amountFields(remainingOf(d)) };
}

/** What the category column shows for a transaction, or null for Uncategorized. */
export function categoryText(l: Lookups, t: Transaction): string | null {
  if (t.splits.length) return `Split (${t.splits.length})`;
  if (isBudgetTransfer(l, t.payeeId) || (t.otherSidePrivate && t.categoryId == null)) return "Transfer";
  if (t.categoryId != null) return l.categoryName.get(t.categoryId) ?? "";
  return null;
}

/** Whether a transaction matches the register's search box. */
export function matchesSearch(l: Lookups, t: Transaction, query: string, showCategory: boolean) {
  const payee = payeeLabel(t.payeeId != null ? l.payeeById.get(t.payeeId) : undefined);
  const ids = t.splits.length ? t.splits.map((s) => s.categoryId) : [t.categoryId];
  const needsCategory = showCategory && !isBudgetTransfer(l, t.payeeId) && !t.otherSidePrivate;
  const cats = ids
    .map((id) => (id != null ? (l.categoryName.get(id) ?? "") : needsCategory ? "uncategorized" : ""))
    .join(" ");
  const text = [
    payee,
    t.notes,
    ...t.splits.map((s) => `${transferLabel(l, s.transferAccountId)} ${s.notes}`),
    cats,
    plain(t.amount),
    formatDate(t.date),
  ];
  return text.join(" ").toLowerCase().includes(query);
}

/** Rows that belong to something else and have to be edited there. */
export type LinkedKind = "investment" | "split" | "private";

export function linkedKind(t: Transaction): LinkedKind | null {
  return t.investmentTxnId ? "investment" : t.fromSplit ? "split" : t.otherSidePrivate ? "private" : null;
}

export const deleteMessage = (t: Transaction | undefined) =>
  t?.transferId ? "Delete this transfer? Both sides will be removed." : "Delete this transaction?";

/** Why the row the user tried to edit has to be edited somewhere else. */
/** Shown after a recurring bill is made from a register transaction. */
export function BillAddedNotice(props: { onDismiss: () => void }) {
  return (
    <p className="notice register-notice" role="status">
      Recurring bill added. It starts with its first due date; manage it on the <Link to="/bills">Bills page</Link>.{" "}
      <button className="link-button" onClick={props.onDismiss}>
        Dismiss
      </button>
    </p>
  );
}

export function LinkedNotice(props: { kind: LinkedKind; onDismiss: () => void }) {
  return (
    <p className="notice register-notice" role="status">
      {props.kind === "investment" ? (
        <>
          That row is the cash side of an investment transaction. Edit it on the{" "}
          <Link to="/investments">Investments page</Link>.
        </>
      ) : props.kind === "split" ? (
        "That row is one line of a split transaction in the account it came from. Edit it there."
      ) : (
        "That row is a transfer with another member's private account, so only they can change it. You can still mark it cleared."
      )}{" "}
      <button className="link-button" onClick={props.onDismiss}>
        Dismiss
      </button>
    </p>
  );
}
