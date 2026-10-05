import { gnucashImportInput, type GnucashMapping, type GnucashUpload } from "@fd/shared";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";
import { commitPlan, listBatches, loadContext, undoBatch } from "../importers/gnucash/commit";
import { MappingError, planImport, suggestMappings } from "../importers/gnucash/plan";
import { BookError, checkFormat, readBook, type GncBook } from "../importers/gnucash/read";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;

interface Upload {
  householdId: number;
  fileName: string;
  book: GncBook;
  expiresAt: number;
}

/** Parsed books waiting for the user to finish the wizard. The file itself is deleted right away. */
const uploads = new Map<string, Upload>();

function purgeExpired(now = Date.now()) {
  for (const [id, u] of uploads) if (u.expiresAt <= now) uploads.delete(id);
}

function getUpload(id: string, householdId: number) {
  purgeExpired();
  const upload = uploads.get(id);
  if (!upload || upload.householdId !== householdId) {
    throw new HTTPException(404, { message: "That upload has expired. Upload the book again." });
  }
  return upload;
}

function cleanFileName(raw: string | undefined) {
  const name = (raw ?? "").split(/[\\/]/).pop()!.trim();
  return name.slice(0, 200) || "book.gnucash";
}

/** Every account's mapping: the user's choice, else the suggestion. */
function effectiveMappings(book: GncBook, ctx: ReturnType<typeof loadContext>, input: Record<string, GnucashMapping>) {
  const suggestions = suggestMappings(book, ctx);
  for (const guid of Object.keys(input)) {
    if (!suggestions.has(guid)) throw new MappingError("The mapping mentions an account that isn't in this book");
  }
  const out: Record<string, GnucashMapping> = {};
  for (const [guid, s] of suggestions) out[guid] = input[guid] ?? s.mapping;
  return out;
}

function plan(
  c: { var: AppEnv["Variables"] },
  householdId: number,
  book: GncBook,
  input: Record<string, GnucashMapping>,
) {
  const ctx = loadContext(c.var.db, householdId);
  try {
    const mappings = effectiveMappings(book, ctx, input);
    return { mappings, plan: planImport(book, mappings, ctx) };
  } catch (err) {
    if (err instanceof MappingError) throw new HTTPException(400, { message: err.message });
    throw err;
  }
}

export const importRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  /** Upload a .gnucash (SQLite) book as the raw request body. `?name=` carries the file name. */
  .post("/gnucash", async (c) => {
    const { householdId } = actorOf(c);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw new HTTPException(413, { message: "That file is too large (200 MB max)" });
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) throw new HTTPException(400, { message: "The file is empty" });
    if (body.byteLength > MAX_UPLOAD_BYTES)
      throw new HTTPException(413, { message: "That file is too large (200 MB max)" });

    const path = join(tmpdir(), `fd-gnucash-${randomUUID()}.gnucash`);
    let book: GncBook;
    try {
      await Bun.write(path, body);
      await checkFormat(path);
      book = readBook(path);
    } catch (err) {
      if (err instanceof BookError) throw new HTTPException(400, { message: err.message });
      throw err;
    } finally {
      await unlink(path).catch(() => {});
    }

    purgeExpired();
    const uploadId = randomUUID();
    const fileName = cleanFileName(c.req.query("name"));
    uploads.set(uploadId, { householdId, fileName, book, expiresAt: Date.now() + UPLOAD_TTL_MS });

    const ctx = loadContext(c.var.db, householdId);
    const suggestions = suggestMappings(book, ctx);
    const used = new Map<string, { count: number; balance: number }>();
    for (const tx of book.transactions) {
      for (const s of tx.splits) {
        const u = used.get(s.accountGuid) ?? { count: 0, balance: 0 };
        u.count++;
        u.balance += s.quantity;
        used.set(s.accountGuid, u);
      }
    }
    const result: GnucashUpload = {
      uploadId,
      fileName,
      currency: book.currency,
      transactionCount: book.transactions.length,
      firstDate: book.transactions[0]?.date ?? null,
      lastDate: book.transactions.at(-1)?.date ?? null,
      accounts: book.accounts.map((a) => ({
        guid: a.guid,
        path: a.path,
        type: a.type,
        placeholder: a.placeholder,
        hidden: a.hidden,
        commodity: a.commodity,
        splitCount: used.get(a.guid)?.count ?? 0,
        balance: used.get(a.guid)?.balance ?? 0,
        suggested: suggestions.get(a.guid)!.mapping,
        remembered: suggestions.get(a.guid)!.remembered,
      })),
    };
    return c.json(result, 201);
  })

  .post("/gnucash/:uploadId/preview", async (c) => {
    const { householdId } = actorOf(c);
    const upload = getUpload(c.req.param("uploadId"), householdId);
    const { mappings } = await parseBody(c, gnucashImportInput);
    return c.json(plan(c, householdId, upload.book, mappings).plan.preview);
  })

  .post("/gnucash/:uploadId/commit", async (c) => {
    const actor = actorOf(c);
    const uploadId = c.req.param("uploadId");
    const upload = getUpload(uploadId, actor.householdId);
    const input = await parseBody(c, gnucashImportInput);
    const result = c.var.db.transaction((tx) => {
      const ctx = loadContext(tx, actor.householdId);
      let mappings: Record<string, GnucashMapping>;
      let p: ReturnType<typeof planImport>;
      try {
        mappings = effectiveMappings(upload.book, ctx, input.mappings);
        p = planImport(upload.book, mappings, ctx);
      } catch (err) {
        if (err instanceof MappingError) throw new HTTPException(400, { message: err.message });
        throw err;
      }
      const batchId = commitPlan(tx, actor, upload.book, p, mappings, upload.fileName);
      return { batchId, preview: p.preview };
    });
    uploads.delete(uploadId);
    return c.json(result, 201);
  })

  .get("/batches", (c) => c.json(listBatches(c.var.db, actorOf(c).householdId)))

  .post("/batches/:id/undo", (c) => {
    undoBatch(c.var.db, actorOf(c).householdId, idParam(c));
    return c.json({ ok: true });
  });
