import { createAccountFolderInput, moveSidebarItemInput, updateAccountFolderInput } from "@fd/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { accountFolders } from "../db/schema";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";
import { createFolder, deleteFolder, getFolder, listFolders, moveSidebarItem } from "../services/folders";

export const folderRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", (c) => c.json(listFolders(c.var.db, actorOf(c).householdId)))

  .post("/", async (c) => {
    const input = await parseBody(c, createAccountFolderInput);
    const { householdId } = actorOf(c);
    const folder = c.var.db.transaction((tx) => createFolder(tx, householdId, input));
    return c.json({ id: folder.id }, 201);
  })

  /** Move an account or a folder within the sidebar. */
  .post("/move", async (c) => {
    const input = await parseBody(c, moveSidebarItemInput);
    const { householdId } = actorOf(c);
    c.var.db.transaction((tx) => moveSidebarItem(tx, householdId, input));
    return c.json({ ok: true });
  })

  .patch("/:id", async (c) => {
    const id = idParam(c);
    const { name } = await parseBody(c, updateAccountFolderInput);
    getFolder(c.var.db, actorOf(c).householdId, id);
    c.var.db.update(accountFolders).set({ name }).where(eq(accountFolders.id, id)).run();
    return c.json({ ok: true });
  })

  /** The folder's accounts and folders move up to where it was. */
  .delete("/:id", (c) => {
    const id = idParam(c);
    const { householdId } = actorOf(c);
    c.var.db.transaction((tx) => deleteFolder(tx, householdId, id));
    return c.json({ ok: true });
  });
