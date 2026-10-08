import type { CategoryGroup } from "@fd/shared";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db";
import { categories, categoryGroups } from "../db/schema";

export function listCategories(db: DbOrTx, householdId: number): CategoryGroup[] {
  const groups = db
    .select({
      id: categoryGroups.id,
      name: categoryGroups.name,
      isIncome: categoryGroups.isIncome,
      hidden: categoryGroups.hidden,
      sortOrder: categoryGroups.sortOrder,
    })
    .from(categoryGroups)
    .where(eq(categoryGroups.householdId, householdId))
    .orderBy(asc(categoryGroups.isIncome), asc(categoryGroups.sortOrder), asc(categoryGroups.id))
    .all();
  const cats = db
    .select({
      id: categories.id,
      groupId: categories.groupId,
      name: categories.name,
      hidden: categories.hidden,
      sortOrder: categories.sortOrder,
      forNextMonth: categories.forNextMonth,
      excludeFromBudget: categories.excludeFromBudget,
      months: categories.months,
    })
    .from(categories)
    .where(eq(categories.householdId, householdId))
    .orderBy(asc(categories.sortOrder), asc(categories.id))
    .all();
  return groups.map((g) => ({ ...g, categories: cats.filter((c) => c.groupId === g.id) }));
}

export function getGroup(db: DbOrTx, householdId: number, id: number) {
  const group = db
    .select()
    .from(categoryGroups)
    .where(and(eq(categoryGroups.id, id), eq(categoryGroups.householdId, householdId)))
    .get();
  if (!group) throw new HTTPException(404, { message: "Category group not found" });
  return group;
}

export function getCategory(db: DbOrTx, householdId: number, id: number) {
  const category = db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.householdId, householdId)))
    .get();
  if (!category) throw new HTTPException(404, { message: "Category not found" });
  return category;
}

/** Insert `id` into `order` before `beforeId` (or at the end), returning the new order. */
function reorder(order: number[], id: number, beforeId: number | null) {
  const rest = order.filter((x) => x !== id);
  const at = beforeId === null ? -1 : rest.indexOf(beforeId);
  if (beforeId !== null && at < 0) throw new HTTPException(400, { message: "Can't place it there" });
  rest.splice(at < 0 ? rest.length : at, 0, id);
  return rest;
}

/** Move a category into a group (possibly its own), before another category or to the end. */
export function moveCategory(db: DbOrTx, householdId: number, id: number, groupId: number, beforeId: number | null) {
  getCategory(db, householdId, id);
  getGroup(db, householdId, groupId);
  const siblings = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.groupId, groupId))
    .orderBy(asc(categories.sortOrder), asc(categories.id))
    .all()
    .map((c) => c.id);
  reorder(siblings, id, beforeId).forEach((cid, i) => {
    db.update(categories)
      .set(cid === id ? { groupId, sortOrder: i } : { sortOrder: i })
      .where(eq(categories.id, cid))
      .run();
  });
}

/** Move a group before another group of the same kind (expense or income), or to the end. */
export function moveGroup(db: DbOrTx, householdId: number, id: number, beforeId: number | null) {
  const group = getGroup(db, householdId, id);
  if (beforeId !== null && getGroup(db, householdId, beforeId).isIncome !== group.isIncome) {
    throw new HTTPException(400, { message: "Income and expense groups are ordered separately" });
  }
  const siblings = db
    .select({ id: categoryGroups.id })
    .from(categoryGroups)
    .where(and(eq(categoryGroups.householdId, householdId), eq(categoryGroups.isIncome, group.isIncome)))
    .orderBy(asc(categoryGroups.sortOrder), asc(categoryGroups.id))
    .all()
    .map((g) => g.id);
  reorder(siblings, id, beforeId).forEach((gid, i) => {
    db.update(categoryGroups).set({ sortOrder: i }).where(eq(categoryGroups.id, gid)).run();
  });
}
