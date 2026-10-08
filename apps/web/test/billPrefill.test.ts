import { expect, test } from "bun:test";
import type { Transaction } from "@fd/shared";
import { billPrefill } from "../src/components/billPrefill";

const txn = (patch: Partial<Transaction>): Transaction => ({
  id: 1,
  accountId: 7,
  date: "2026-10-05",
  amount: -150000,
  payeeId: 3,
  categoryId: 12,
  notes: "Apartment",
  cleared: true,
  reconciled: false,
  inBudget: false,
  transferId: null,
  otherSidePrivate: false,
  investmentTxnId: null,
  fromSplit: false,
  scheduledBillId: null,
  splits: [],
  runningBalance: 0,
  createdBy: null,
  updatedBy: null,
  ...patch,
});

test("a payment fills the account, payee, amount, category and notes", () => {
  expect(billPrefill(txn({}), "2026-10-08")).toEqual({
    accountId: 7,
    payeeId: 3,
    amount: -150000,
    categoryId: 12,
    notes: "Apartment",
    startDate: "2026-11-05",
    split: false,
  });
});

test("a deposit keeps its sign, and a transfer keeps its transfer payee", () => {
  expect(billPrefill(txn({ amount: 250000 }), "2026-10-08").amount).toBe(250000);
  const transfer = billPrefill(txn({ payeeId: 9, categoryId: null, transferId: 44 }), "2026-10-08");
  expect(transfer).toMatchObject({ payeeId: 9, categoryId: null });
});

test("a split leaves the category for the user to pick", () => {
  const split = txn({
    categoryId: null,
    splits: [
      { id: 2, amount: -100000, categoryId: 12, notes: "", transferAccountId: null },
      { id: 3, amount: -50000, categoryId: 13, notes: "", transferAccountId: null },
    ],
  });
  expect(billPrefill(split, "2026-10-08")).toMatchObject({ categoryId: null, split: true, amount: -150000 });
});

test("the first due date is the next month that's after both the transaction and today", () => {
  const due = (date: string, today: string) => billPrefill(txn({ date }), today).startDate;
  // Paid this month: next month.
  expect(due("2026-10-05", "2026-10-08")).toBe("2026-11-05");
  // Paid on the last day of a long month: shorter months use their last day.
  expect(due("2026-01-31", "2026-02-01")).toBe("2026-02-28");
  // An old transaction: the next one still to come.
  expect(due("2026-03-20", "2026-10-08")).toBe("2026-10-20");
  expect(due("2026-03-05", "2026-10-08")).toBe("2026-11-05");
  // Dated later this month (e.g. already posted by a bill): the month after.
  expect(due("2026-10-20", "2026-10-08")).toBe("2026-11-20");
  // Due today was already paid: next month.
  expect(due("2026-09-08", "2026-10-08")).toBe("2026-11-08");
});
