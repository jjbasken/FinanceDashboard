import { expect, test } from "bun:test";
import type { Account } from "@fd/shared";
import { entryAccounts, needsNoAccount } from "../src/components/entryAccounts";

const checking = { id: 1, onBudget: true, type: "checking" } as Account;
const card = { id: 2, onBudget: true, type: "credit" } as Account;
const savings = { id: 3, onBudget: true, type: "savings" } as Account;
const open = [checking, card, savings];

test("account-page entry starts on that account and permits another selection", () => {
  expect(entryAccounts(open, [2], 1, false, 1)).toEqual({ account: checking, shown: [checking, card] });
  expect(entryAccounts(open, [2], 2, false, 1)).toEqual({ account: card, shown: [checking, card] });
  expect(entryAccounts(open, [], 2, false, 1).account).toBe(card);
  expect(entryAccounts(open, [2], 3, true, 1).account).toBe(savings);
});

test("expanding options preserves the displayed account instead of restoring the last-used account", () => {
  // The stored last-used card is outside the shortlist, so entry starts on checking.
  const before = entryAccounts(open, [1], 2, false);
  expect(before.account).toBe(checking);
  // QuickEntry pins the displayed account when the user chooses More accounts.
  const expanded = entryAccounts(open, [1], before.account!.id, true);
  expect(expanded).toEqual({ account: checking, shown: open });
  expect(entryAccounts(open, [1], 3, true).account).toBe(savings);
});

test("empty or ineligible preferences list every eligible account", () => {
  expect(entryAccounts(open, [], 2, false)).toEqual({ account: card, shown: open });
  expect(entryAccounts(open, [99], 2, false)).toEqual({ account: card, shown: open });
  expect(entryAccounts([], [1], 1, false, 1)).toEqual({ account: undefined, shown: [] });
});

test("No account is offered last but only selected when chosen or when nothing else is open", () => {
  const noAccount = { id: 9, onBudget: true, type: "cash", budgetOnly: true } as Account;
  expect(entryAccounts(open, [], null, false, undefined, noAccount)).toEqual({ account: checking, shown: [...open, noAccount] });
  expect(entryAccounts(open, [2], 2, false, undefined, noAccount)).toEqual({ account: card, shown: [card, noAccount] });
  expect(entryAccounts(open, [2], 9, false, undefined, noAccount).account).toBe(noAccount);
  expect(entryAccounts([], [], null, false, undefined, noAccount)).toEqual({ account: noAccount, shown: [noAccount] });
});

test("No account is only needed when it was asked for or nothing else is open", () => {
  expect(needsNoAccount(open)).toBe(false);
  expect(needsNoAccount(open, 2)).toBe(false);
  expect(needsNoAccount(open, 9)).toBe(true);
  expect(needsNoAccount([])).toBe(true);
});
