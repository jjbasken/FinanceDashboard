import type { DbOrTx } from "../db";
import { categories, categoryGroups, households } from "../db/schema";

/** The income category that opening balances are filed under. */
export const STARTING_BALANCES = "Starting Balances";

/** Default categories for a new household, in the spirit of Actual's starter budget. */
const DEFAULT_CATEGORIES: { name: string; isIncome?: boolean; rollover?: boolean; categories: string[] }[] = [
  { name: "Bills", categories: ["Housing", "Utilities", "Phone & Internet", "Insurance"] },
  { name: "Everyday", categories: ["Groceries", "Dining Out", "Transportation", "Household", "Personal"] },
  { name: "Savings", rollover: true, categories: ["Emergency Fund", "Vacation"] },
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
      .values(
        group.categories.map((c, ci) => ({
          householdId: household.id,
          groupId,
          name: c,
          rollover: group.rollover ?? false,
          sortOrder: ci,
        })),
      )
      .run();
  });
  return household;
}
