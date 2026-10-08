import {
  bankCommitInput,
  bankPreviewInput,
  gnucashImportInput,
  type BankUpload,
  type CsvMapping,
  type FundImportResult,
  type FundStatementPreview,
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
import { actorOf, idParam, parseBody, requireAuth, sessionOf } from "../middleware";
import { commitPlan, listBatches, loadContext, undoBatch } from "../importers/gnucash/commit";
import { MappingError, planImport, suggestMappings } from "../importers/gnucash/plan";
import { BookError, checkFormat, readBook, type GncBook } from "../importers/gnucash/read";
import { isGnucashCsv, readGnucashCsv } from "../importers/gnucash/csv";
import { isGnucashXml, readGnucashXml } from "../importers/gnucash/xml";
import { commitBankImport, planBankImport } from "../importers/bank/plan";
import {
  BankFileError,
  csvToTxns,
  csvWidth,
  detectFormat,
  parseCsv,
  parseOfx,
  suggestCsvMapping,
  type BankTxn,
} from "../importers/bank/parse";
import { commitFundImport, parseFundStatement, planFundImport, type Statement } from "../importers/fund/statement";
import { visibleAccount, type Actor } from "../services/ledger";
import { localDate } from "../util";
import { ImportPreviews, previewBytes, readUpload } from "../services/import-previews";
import { listCategories } from "../services/categories";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;


interface Upload {
  householdId: number;
  fileName: string;
  book: GncBook;
}

interface BankFile {
  householdId: number;
  accountId: number;
  fileName: string;
  format: "ofx" | "csv";
  ofx?: BankTxn[];
  csv?: string[][];
}

interface FundFile {
  householdId: number;
  accountId: number;
  fileName: string;
  statement: Statement;
}

/** The file's transactions, reading CSV with the given column mapping. */
function bankTxns(upload: BankFile, csv: CsvMapping | undefined) {
  if (upload.format === "ofx") return { txns: upload.ofx!, errors: [] };
  if (!csv) throw new HTTPException(400, { message: "Choose which columns hold the date and amount" });
  const width = csvWidth(upload.csv!);
  const cols = [csv.date, csv.payee, csv.notes, csv.amount, csv.debit, csv.credit].filter((c) => c !== null);
  if (cols.some((c) => c! >= width)) throw new HTTPException(400, { message: "That column isn't in the file" });
  if (csv.amount === null && csv.debit === null && csv.credit === null) {
    throw new HTTPException(400, { message: "Choose the amount column (or debit and credit columns)" });
  }
  return csvToTxns(upload.csv!, csv);
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
  actor: Actor,
  book: GncBook,
  input: Record<string, GnucashMapping>,
) {
  const ctx = loadContext(c.var.db, actor);
  try {
    const mappings = effectiveMappings(book, ctx, input);
    return { mappings, plan: planImport(book, mappings, ctx) };
  } catch (err) {
    if (err instanceof MappingError) throw new HTTPException(400, { message: err.message });
    throw err;
  }
}

export function createImportRoutes() {
  const previews = new ImportPreviews();
  return new Hono<AppEnv>()
    .use(requireAuth)
    .use(async (c, next) => {
      if (c.req.method !== "POST" || !["/api/import/gnucash", "/api/import/bank", "/api/import/fund"].includes(c.req.path)) {
        return next();
      }
      const release = previews.begin(actorOf(c).userId);
      try {
        await next();
      } finally {
        release();
      }
    })

    /** Upload a .gnucash (SQLite) book as the raw request body. `?name=` carries the file name. */
    .post("/gnucash", async (c) => {
      const { householdId } = actorOf(c);
      const body = await readUpload(c.req.raw, MAX_UPLOAD_BYTES);

      // A whole book (GnuCash's default compressed XML, or sqlite3), or a CSV export of some accounts.
      let book: GncBook;
      let source: GnucashUpload["source"] = "book";
      const text = body.byteLength < 64 * 1024 * 1024 ? new TextDecoder().decode(body.slice(0, 4096)) : "";
      const bytes = new Uint8Array(body);
      if (isGnucashCsv(text) || isGnucashXml(bytes)) {
        source = isGnucashCsv(text) ? "csv" : "book";
        try {
          book = source === "csv" ? readGnucashCsv(new TextDecoder().decode(body)) : readGnucashXml(bytes);
        } catch (err) {
          if (err instanceof BookError || err instanceof BankFileError) throw new HTTPException(400, { message: err.message });
          throw err;
        }
      } else {
        const path = join(tmpdir(), `fd-gnucash-${randomUUID()}.gnucash`);
        try {
          await Bun.write(path, body);
          await checkFormat(path);
          book = readBook(path);
        } catch (err) {
          if (err instanceof BookError || err instanceof BankFileError) throw new HTTPException(400, { message: err.message });
          throw err;
        } finally {
          await unlink(path).catch(() => {});
        }
      }

      previewBytes(book);
      const uploadId = randomUUID();
      const fileName = cleanFileName(c.req.query("name"));
      previews.set(`gnucash:${uploadId}`, actorOf(c).userId, householdId, { householdId, fileName, book });

      const ctx = loadContext(c.var.db, actorOf(c));
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
        source,
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
      const upload = previews.get<Upload>(`gnucash:${c.req.param("uploadId")}`, householdId);
      const { mappings } = await parseBody(c, gnucashImportInput);
      return c.json(plan(c, actorOf(c), upload.book, mappings).plan.preview);
    })

    .post("/gnucash/:uploadId/commit", async (c) => {
      const actor = actorOf(c);
      const uploadId = c.req.param("uploadId");
      const upload = previews.get<Upload>(`gnucash:${uploadId}`, actor.householdId);
      const input = await parseBody(c, gnucashImportInput);
      const result = c.var.db.transaction((tx) => {
        const ctx = loadContext(tx, actor);
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
      previews.delete(`gnucash:${uploadId}`);
      c.var.log.info("import", `Imported GnuCash file ${upload.fileName}`, {
        householdId: actor.householdId,
        details: { batchId: result.batchId, user: sessionOf(c).user.username },
      });
      return c.json(result, 201);
    })

    /** Upload a bank statement (OFX/QFX or CSV) for one account, as the raw request body. */
    .post("/bank", async (c) => {
      const { householdId } = actorOf(c);
      const accountId = Number(c.req.query("accountId"));
      if (!Number.isInteger(accountId) || accountId <= 0) throw new HTTPException(400, { message: "Pick an account" });
      visibleAccount(c.var.db, actorOf(c), accountId);
      const body = await readUpload(c.req.raw, 20 * 1024 * 1024);

      const text = new TextDecoder().decode(body);
      const format = detectFormat(text);
      const fileName = cleanFileName(c.req.query("name"));
      const upload: BankFile = { householdId, accountId, fileName, format };
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
      const uploadId = randomUUID();
      previews.set(`bank:${uploadId}`, actorOf(c).userId, householdId, upload);
      const result: BankUpload = { uploadId, fileName, format, accountId };
      if (upload.csv) result.csv = { rows: upload.csv.slice(0, 8), suggested: suggestCsvMapping(upload.csv) };
      return c.json(result, 201);
    })

    .post("/bank/:uploadId/preview", async (c) => {
      const { householdId } = actorOf(c);
      const upload = previews.get<BankFile>(`bank:${c.req.param("uploadId")}`, householdId);
      const { csv } = await parseBody(c, bankPreviewInput);
      const { txns, errors } = bankTxns(upload, csv);
      const account = visibleAccount(c.var.db, actorOf(c), upload.accountId);
      const { ids: _ids, ...preview } = planBankImport(c.var.db, householdId, account, txns);
      return c.json({ ...preview, errors });
    })

    .post("/bank/:uploadId/commit", async (c) => {
      const actor = actorOf(c);
      const uploadId = c.req.param("uploadId");
      const upload = previews.get<BankFile>(`bank:${uploadId}`, actor.householdId);
      const input = await parseBody(c, bankCommitInput);
      const { txns } = bankTxns(upload, input.csv);
      const result = c.var.db.transaction((tx) => {
        const account = visibleAccount(tx, actor, upload.accountId);
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
      previews.delete(`bank:${uploadId}`);
      c.var.log.info(
        "import",
        `Imported ${upload.fileName}: ${result.created} new, ${result.matched} matched to existing transactions`,
        { householdId: actor.householdId, details: { ...result, user: sessionOf(c).user.username } },
      );
      return c.json(result, 201);
    })

    /** Upload a fund statement CSV (e.g. from a 529 plan) for an account; returns the preview. */
    .post("/fund", async (c) => {
      const { householdId } = actorOf(c);
      const accountId = Number(c.req.query("accountId"));
      if (!Number.isInteger(accountId) || accountId <= 0) throw new HTTPException(400, { message: "Pick an account" });
      const account = visibleAccount(c.var.db, actorOf(c), accountId);
      if (account.closed) throw new HTTPException(400, { message: "That account is closed" });
      const body = await readUpload(c.req.raw, 5 * 1024 * 1024);
      let statement: Statement;
      try {
        statement = parseFundStatement(new TextDecoder().decode(body));
      } catch (err) {
        if (err instanceof BankFileError) throw new HTTPException(400, { message: err.message });
        throw err;
      }
      const uploadId = randomUUID();
      const fileName = cleanFileName(c.req.query("name"));
      previews.set(`fund:${uploadId}`, actorOf(c).userId, householdId, { householdId, accountId, fileName, statement });
      const plan = planFundImport(c.var.db, householdId, accountId, statement, localDate());
      const items = plan.items.map(({ importedId: _id, ...i }) => i);
      const preview: FundStatementPreview = {
        uploadId,
        fileName,
        accountId,
        openingDate: plan.openingDate,
        funds: plan.funds,
        items,
        counts: {
          new: items.filter((i) => i.status === "new").length,
          duplicate: items.filter((i) => i.status === "duplicate").length,
        },
        errors: statement.errors,
      };
      return c.json(preview, 201);
    })

    .post("/fund/:uploadId/commit", (c) => {
      const actor = actorOf(c);
      const uploadId = c.req.param("uploadId");
      const upload = previews.get<FundFile>(`fund:${uploadId}`, actor.householdId);
      const result: FundImportResult = c.var.db.transaction((tx) => {
        visibleAccount(tx, actor, upload.accountId);
        const plan = planFundImport(tx, actor.householdId, upload.accountId, upload.statement, localDate());
        return commitFundImport(tx, actor, upload.accountId, upload.fileName, plan);
      });
      previews.delete(`fund:${uploadId}`);
      c.var.log.info("import", `Imported ${upload.fileName}: ${result.created} investment transactions`, {
        householdId: actor.householdId,
        details: { ...result, user: sessionOf(c).user.username },
      });
      return c.json(result, 201);
    })

    .get("/batches", (c) => c.json(listBatches(c.var.db, actorOf(c).householdId)))

    .post("/batches/:id/undo", (c) => {
      const actor = actorOf(c);
      const id = idParam(c);
      undoBatch(c.var.db, actor, id);
      c.var.log.info("import", `Undid import #${id}`, {
        householdId: actor.householdId,
        details: { batchId: id, user: sessionOf(c).user.username },
      });
      return c.json({ ok: true });
    });
}
