import type { DbOrTx } from "../db";
import { accounts, categories, categoryGroups, households, payees } from "../db/schema";

/** The income category that opening balances are filed under. */
export const STARTING_BALANCES = "Starting Balances";

/** The built-in account for spending recorded for the budget only. */
export const BUDGET_ONLY_ACCOUNT = "No account";

/** Default categories for a new household, in the spirit of Actual's starter budget. */
const DEFAULT_CATEGORIES: { name: string; isIncome?: boolean; categories: string[] }[] = [
  { name: "Bills", categories: ["Housing", "Utilities", "Phone & Internet", "Insurance"] },
  { name: "Everyday", categories: ["Groceries", "Dining Out", "Transportation", "Household", "Personal"] },
  { name: "Savings", categories: ["Emergency Fund", "Vacation"] },
  { name: "Income", isIncome: true, categories: ["Income", STARTING_BALANCES] },
];

export function createHousehold(tx: DbOrTx, name: string) {
  const household = tx.insert(households).values({ name }).returning().get();
  DEFAULT_CATEGORIES.forEach((group, gi) => {
    const { id: groupId } = tx
      .insert(categoryGroups)
      .values({ householdId: household.id, name: group.name, isIncome: group.isIncome ?? false, sortOrder: gi })
      .returning({ id: categoryGroups.id })
      .get();
    tx.insert(categories)
      .values(group.categories.map((c, ci) => ({ householdId: household.id, groupId, name: c, sortOrder: ci })))
      .run();
  });
  const account = tx
    .insert(accounts)
    .values({
      householdId: household.id,
      name: BUDGET_ONLY_ACCOUNT,
      type: "cash",
      onBudget: true,
      excludeFromNetWorth: true,
      budgetOnly: true,
    })
    .returning({ id: accounts.id })
    .get();
  tx.insert(payees).values({ householdId: household.id, name: BUDGET_ONLY_ACCOUNT, transferAccountId: account.id }).run();
  return household;
}
