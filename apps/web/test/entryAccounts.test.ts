import { expect, test } from "bun:test";
import type { Account } from "@fd/shared";
import { entryAccounts } from "../src/components/entryAccounts";

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
