import {
  createCategoryGroupInput,
  createCategoryInput,
  updateCategoryGroupInput,
  updateCategoryInput,
  type CategoryGroup,
} from "@fd/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import type { DbOrTx } from "../db";
import { categories, categoryGroups, transactions } from "../db/schema";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";

function listCategories(db: DbOrTx, householdId: number): CategoryGroup[] {
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
    })
    .from(categories)
    .where(eq(categories.householdId, householdId))
    .orderBy(asc(categories.sortOrder), asc(categories.id))
    .all();
  return groups.map((g) => ({ ...g, categories: cats.filter((c) => c.groupId === g.id) }));
}

function getGroup(db: DbOrTx, householdId: number, id: number) {
  const group = db
    .select()
    .from(categoryGroups)
    .where(and(eq(categoryGroups.id, id), eq(categoryGroups.householdId, householdId)))
    .get();
  if (!group) throw new HTTPException(404, { message: "Category group not found" });
  return group;
}

function getCategory(db: DbOrTx, householdId: number, id: number) {
  const category = db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.householdId, householdId)))
    .get();
  if (!category) throw new HTTPException(404, { message: "Category not found" });
  return category;
}

export const categoryRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", (c) => c.json(listCategories(c.var.db, actorOf(c).householdId)))

  .post("/groups", async (c) => {
    const input = await parseBody(c, createCategoryGroupInput);
    const { householdId } = actorOf(c);
    const [{ next } = { next: 0 }] = c.var.db
      .select({ next: sql<number>`coalesce(max(${categoryGroups.sortOrder}), -1) + 1` })
      .from(categoryGroups)
      .where(eq(categoryGroups.householdId, householdId))
      .all();
    const group = c.var.db
      .insert(categoryGroups)
      .values({ householdId, name: input.name, isIncome: input.isIncome ?? false, sortOrder: next })
      .returning({ id: categoryGroups.id })
      .get();
    return c.json({ id: group.id }, 201);
  })

  .patch("/groups/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateCategoryGroupInput);
    getGroup(c.var.db, actorOf(c).householdId, id);
    c.var.db.update(categoryGroups).set(input).where(eq(categoryGroups.id, id)).run();
    return c.json({ ok: true });
  })

  /** Deleting a group deletes its categories; their transactions become uncategorised. */
  .delete("/groups/:id", (c) => {
    const id = idParam(c);
    getGroup(c.var.db, actorOf(c).householdId, id);
    c.var.db.delete(categoryGroups).where(eq(categoryGroups.id, id)).run();
    return c.json({ ok: true });
  })

  .post("/", async (c) => {
    const input = await parseBody(c, createCategoryInput);
    const { householdId } = actorOf(c);
    getGroup(c.var.db, householdId, input.groupId);
    const [{ next } = { next: 0 }] = c.var.db
      .select({ next: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
      .from(categories)
      .where(eq(categories.groupId, input.groupId))
      .all();
    const category = c.var.db
      .insert(categories)
      .values({ householdId, groupId: input.groupId, name: input.name, sortOrder: next })
      .returning({ id: categories.id })
      .get();
    return c.json({ id: category.id }, 201);
  })

  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateCategoryInput);
    const { householdId } = actorOf(c);
    getCategory(c.var.db, householdId, id);
    if (input.groupId !== undefined) getGroup(c.var.db, householdId, input.groupId);
    c.var.db.update(categories).set(input).where(eq(categories.id, id)).run();
    return c.json({ ok: true });
  })

  /** `?transferTo=<id>` moves the category's transactions to another category first. */
  .delete("/:id", (c) => {
    const id = idParam(c);
    const { householdId } = actorOf(c);
    getCategory(c.var.db, householdId, id);
    const transferTo = c.req.query("transferTo");
    const targetId = transferTo ? Number(transferTo) : null;
    if (targetId !== null) {
      if (!Number.isInteger(targetId) || targetId === id) {
        throw new HTTPException(400, { message: "Pick a different category to move transactions to" });
      }
      getCategory(c.var.db, householdId, targetId);
    }
    c.var.db.transaction((tx) => {
      if (targetId !== null) {
        tx.update(transactions).set({ categoryId: targetId }).where(eq(transactions.categoryId, id)).run();
      }
      tx.delete(categories).where(eq(categories.id, id)).run();
    });
    return c.json({ ok: true });
  });
