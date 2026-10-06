import {
  bankCommitInput,
  bankPreviewInput,
  gnucashImportInput,
  type BankUpload,
  type CsvMapping,
  type GnucashMapping,
  type GnucashUpload,
} from "@fd/shared";
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
import { commitBankImport, planBankImport } from "../importers/bank/plan";
import {
  BankFileError,
  csvToTxns,
  detectFormat,
  parseCsv,
  parseOfx,
  suggestCsvMapping,
  type BankTxn,
} from "../importers/bank/parse";
import { getAccount } from "../services/ledger";
import { listCategories } from "../services/categories";

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

interface BankFile {
  householdId: number;
  accountId: number;
  fileName: string;
  format: "ofx" | "csv";
  ofx?: BankTxn[];
  csv?: string[][];
  expiresAt: number;
}

/** Bank statement files waiting for review. */
const bankUploads = new Map<string, BankFile>();

function purgeExpired(now = Date.now()) {
  for (const [id, u] of uploads) if (u.expiresAt <= now) uploads.delete(id);
  for (const [id, u] of bankUploads) if (u.expiresAt <= now) bankUploads.delete(id);
}

function getBankUpload(id: string, householdId: number) {
  purgeExpired();
  const upload = bankUploads.get(id);
  if (!upload || upload.householdId !== householdId) {
    throw new HTTPException(404, { message: "That upload has expired. Upload the file again." });
  }
  return upload;
}

/** The file's transactions, reading CSV with the given column mapping. */
function bankTxns(upload: BankFile, csv: CsvMapping | undefined) {
  if (upload.format === "ofx") return { txns: upload.ofx!, errors: [] };
  if (!csv) throw new HTTPException(400, { message: "Choose which columns hold the date and amount" });
  const width = Math.max(...upload.csv!.map((r) => r.length));
  const cols = [csv.date, csv.payee, csv.notes, csv.amount, csv.debit, csv.credit].filter((c) => c !== null);
  if (cols.some((c) => c! >= width)) throw new HTTPException(400, { message: "That column isn't in the file" });
  if (csv.amount === null && csv.debit === null && csv.credit === null) {
    throw new HTTPException(400, { message: "Choose the amount column (or debit and credit columns)" });
  }
  return csvToTxns(upload.csv!, csv);
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

  /** Upload a bank statement (OFX/QFX or CSV) for one account, as the raw request body. */
  .post("/bank", async (c) => {
    const { householdId } = actorOf(c);
    const accountId = Number(c.req.query("accountId"));
    if (!Number.isInteger(accountId) || accountId <= 0) throw new HTTPException(400, { message: "Pick an account" });
    getAccount(c.var.db, householdId, accountId);
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) throw new HTTPException(400, { message: "The file is empty" });
    if (body.byteLength > 20 * 1024 * 1024)
      throw new HTTPException(413, { message: "That file is too large (20 MB max)" });

    const text = new TextDecoder().decode(body);
    const format = detectFormat(text);
    const fileName = cleanFileName(c.req.query("name"));
    const upload: BankFile = { householdId, accountId, fileName, format, expiresAt: Date.now() + UPLOAD_TTL_MS };
    try {
      if (format === "ofx") upload.ofx = parseOfx(text);
      else {
        upload.csv = parseCsv(text);
        if (upload.csv.length === 0) throw new BankFileError("That file has no rows.");
      }
    } catch (err) {
      if (err instanceof BankFileError) throw new HTTPException(400, { message: err.message });
      throw err;
    }
    purgeExpired();
    const uploadId = randomUUID();
    bankUploads.set(uploadId, upload);
    const result: BankUpload = { uploadId, fileName, format, accountId };
    if (upload.csv) result.csv = { rows: upload.csv.slice(0, 8), suggested: suggestCsvMapping(upload.csv) };
    return c.json(result, 201);
  })

  .post("/bank/:uploadId/preview", async (c) => {
    const { householdId } = actorOf(c);
    const upload = getBankUpload(c.req.param("uploadId"), householdId);
    const { csv } = await parseBody(c, bankPreviewInput);
    const { txns, errors } = bankTxns(upload, csv);
    const account = getAccount(c.var.db, householdId, upload.accountId);
    const { ids: _ids, ...preview } = planBankImport(c.var.db, householdId, account, txns);
    return c.json({ ...preview, errors });
  })

  .post("/bank/:uploadId/commit", async (c) => {
    const actor = actorOf(c);
    const uploadId = c.req.param("uploadId");
    const upload = getBankUpload(uploadId, actor.householdId);
    const input = await parseBody(c, bankCommitInput);
    const { txns } = bankTxns(upload, input.csv);
    const result = c.var.db.transaction((tx) => {
      const account = getAccount(tx, actor.householdId, upload.accountId);
      const categoryIds = new Set(listCategories(tx, actor.householdId).flatMap((g) => g.categories.map((x) => x.id)));
      return commitBankImport(tx, actor, {
        account,
        format: upload.format,
        fileName: upload.fileName,
        plan: planBankImport(tx, actor.householdId, account, txns),
        include: new Set(input.include),
        categories: input.categories ?? {},
        validCategory: (id) => categoryIds.has(id),
      });
    });
    bankUploads.delete(uploadId);
    return c.json(result, 201);
  })

  .get("/batches", (c) => c.json(listBatches(c.var.db, actorOf(c).householdId)))

  .post("/batches/:id/undo", (c) => {
    undoBatch(c.var.db, actorOf(c).householdId, idParam(c));
    return c.json({ ok: true });
  });
