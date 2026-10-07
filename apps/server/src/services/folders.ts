import {
  accountSection,
  compareSidebarItems,
  type AccountFolder,
  type AccountSection,
  type CreateAccountFolderInput,
  type MoveSidebarItemInput,
  type SidebarItem,
} from "@fd/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db";
import { accountFolders, accounts } from "../db/schema";

const badRequest = (message: string) => new HTTPException(400, { message });

export function listFolders(db: DbOrTx, householdId: number): AccountFolder[] {
  return db
    .select({
      id: accountFolders.id,
      name: accountFolders.name,
      section: accountFolders.section,
      parentId: accountFolders.parentId,
      sortOrder: accountFolders.sortOrder,
    })
    .from(accountFolders)
    .where(eq(accountFolders.householdId, householdId))
    .orderBy(asc(accountFolders.sortOrder), asc(accountFolders.id))
    .all();
}

export function getFolder(db: DbOrTx, householdId: number, id: number) {
  const folder = db
    .select()
    .from(accountFolders)
    .where(and(eq(accountFolders.id, id), eq(accountFolders.householdId, householdId)))
    .get();
  if (!folder) throw new HTTPException(404, { message: "Folder not found" });
  return folder;
}

/** A sort order after every account and folder, so a new one lands at the end of its section. */
export function nextSidebarOrder(db: DbOrTx, householdId: number) {
  const [row] = db.all<{ next: number }>(sql`
    select max(
      coalesce((select max(sort_order) from accounts where household_id = ${householdId}), -1),
      coalesce((select max(sort_order) from account_folders where household_id = ${householdId}), -1)
    ) + 1 as next
  `);
  return row?.next ?? 0;
}

/** Check that `parentId` (if any) is a folder in `section`, for something being put inside it. */
export function assertParent(db: DbOrTx, householdId: number, parentId: number | null, section: AccountSection) {
  if (parentId === null) return;
  if (getFolder(db, householdId, parentId).section !== section) {
    throw badRequest("That folder is in a different section");
  }
}

export function createFolder(db: DbOrTx, householdId: number, input: CreateAccountFolderInput) {
  const parentId = input.parentId ?? null;
  assertParent(db, householdId, parentId, input.section);
  return db
    .insert(accountFolders)
    .values({
      householdId,
      name: input.name,
      section: input.section,
      parentId,
      sortOrder: nextSidebarOrder(db, householdId),
    })
    .returning({ id: accountFolders.id })
    .get();
}

type Sibling = SidebarItem & { sortOrder: number };

const key = (item: SidebarItem) => `${item.kind}:${item.id}`;

/** The accounts and folders directly inside `parentId` (or at the top of `section`), in order. */
function children(db: DbOrTx, householdId: number, section: AccountSection, parentId: number | null): Sibling[] {
  const folders = listFolders(db, householdId)
    .filter((f) => f.section === section && f.parentId === parentId)
    .map((f) => ({ kind: "folder" as const, id: f.id, sortOrder: f.sortOrder }));
  const accts = db
    .select({
      id: accounts.id,
      type: accounts.type,
      onBudget: accounts.onBudget,
      folderId: accounts.folderId,
      sortOrder: accounts.sortOrder,
    })
    .from(accounts)
    .where(eq(accounts.householdId, householdId))
    .all()
    .filter((a) => accountSection(a) === section && a.folderId === parentId)
    .map((a) => ({ kind: "account" as const, id: a.id, sortOrder: a.sortOrder }));
  return [...folders, ...accts].sort(compareSidebarItems);
}

/** Give `items` the sort orders 0, 1, 2, … and put them all in `parentId`. */
function place(db: DbOrTx, items: SidebarItem[], parentId: number | null) {
  items.forEach((item, sortOrder) => {
    if (item.kind === "folder") {
      db.update(accountFolders).set({ parentId, sortOrder }).where(eq(accountFolders.id, item.id)).run();
    } else {
      db.update(accounts).set({ folderId: parentId, sortOrder }).where(eq(accounts.id, item.id)).run();
    }
  });
}

/** Whether `folderId` is `ancestorId` or somewhere inside it. */
function isWithin(db: DbOrTx, householdId: number, folderId: number, ancestorId: number) {
  const parents = new Map(listFolders(db, householdId).map((f) => [f.id, f.parentId]));
  for (let at: number | null = folderId; at !== null; at = parents.get(at) ?? null) {
    if (at === ancestorId) return true;
  }
  return false;
}

/** Move an account or folder into a folder (or the top of its section), before a sibling or to the end. */
export function moveSidebarItem(db: DbOrTx, householdId: number, input: MoveSidebarItemInput) {
  const { item, parentId, before } = input;
  let section: AccountSection;
  if (item.kind === "folder") {
    section = getFolder(db, householdId, item.id).section;
    if (parentId !== null && isWithin(db, householdId, parentId, item.id)) {
      throw badRequest("A folder can't go inside itself");
    }
  } else {
    const account = db
      .select({ type: accounts.type, onBudget: accounts.onBudget })
      .from(accounts)
      .where(and(eq(accounts.id, item.id), eq(accounts.householdId, householdId)))
      .get();
    if (!account) throw new HTTPException(404, { message: "Account not found" });
    section = accountSection(account);
  }
  assertParent(db, householdId, parentId, section);

  const order: SidebarItem[] = children(db, householdId, section, parentId).filter((s) => key(s) !== key(item));
  const at = before ? order.findIndex((s) => key(s) === key(before)) : order.length;
  if (at < 0) throw badRequest("Can't place it there");
  order.splice(at, 0, item);
  place(db, order, parentId);
}

/** Delete a folder. What was in it moves up to where the folder was. */
export function deleteFolder(db: DbOrTx, householdId: number, id: number) {
  const folder = getFolder(db, householdId, id);
  const contents = children(db, householdId, folder.section, id);
  const order: SidebarItem[] = children(db, householdId, folder.section, folder.parentId).flatMap((s) =>
    s.kind === "folder" && s.id === id ? contents : [s],
  );
  place(db, order, folder.parentId);
  db.delete(accountFolders).where(eq(accountFolders.id, id)).run();
}
