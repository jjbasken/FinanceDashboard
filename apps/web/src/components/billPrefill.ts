import { nextOccurrence, type Transaction } from "@fd/shared";

/** What a new recurring bill starts with when it's made from a register transaction. */
export interface BillPrefill {
  accountId: number;
  payeeId: number | null;
  amount: number;
  categoryId: number | null;
  notes: string;
  /** The first due date. */
  startDate: string;
  /** The transaction was split; a bill has one category, so none is filled in. */
  split: boolean;
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * A recurring bill based on a transaction: same account, payee, amount, category and notes, due
 * monthly on the same day. It starts with the first month after both the transaction and today,
 * so it never adds a second copy of a payment that's already in the register.
 */
export function billPrefill(t: Transaction, today: string): BillPrefill {
  const split = t.splits.length > 0;
  const from = addDays(t.date > today ? t.date : today, 1);
  return {
    accountId: t.accountId,
    payeeId: t.payeeId,
    amount: t.amount,
    categoryId: split ? null : t.categoryId,
    notes: t.notes,
    startDate: nextOccurrence({ frequency: "monthly", startDate: t.date, endDate: null }, from)!,
    split,
  };
}
