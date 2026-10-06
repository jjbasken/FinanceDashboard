import { Database } from "bun:sqlite";
import { rationalToCents } from "@fd/shared";

export interface GncAccount {
  guid: string;
  name: string;
  /** Full path below the root, e.g. "Expenses:Auto:Fuel". */
  path: string;
  /** GnuCash account type: BANK, CASH, CREDIT, ASSET, LIABILITY, STOCK, MUTUAL, INCOME, EXPENSE, EQUITY, ... */
  type: string;
  parentGuid: string | null;
  /** Commodity mnemonic, e.g. USD or AAPL. */
  commodity: string;
  /** Commodity full name and namespace (e.g. "Apple Inc.", "NASDAQ" or "FUND"). */
  commodityName: string;
  commodityNamespace: string;
  placeholder: boolean;
  hidden: boolean;
}

export interface GncSplit {
  guid: string;
  accountGuid: string;
  memo: string;
  /** n = new, c = cleared, y = reconciled, f = frozen, v = voided */
  reconcile: string;
  /** In the transaction's currency, cents. */
  value: number;
  /** In the account's commodity, cents (for currency accounts). */
  quantity: number;
  /** In the account's commodity, millionths (micro-shares for stock accounts). */
  shares: number;
}

export interface GncPrice {
  commodity: string;
  currency: string;
  date: string;
  /** Micro-units of the currency. */
  value: number;
}

export interface GncTransaction {
  guid: string;
  date: string;
  num: string;
  description: string;
  notes: string;
  currency: string;
  splits: GncSplit[];
}

export interface GncBook {
  currency: string;
  accounts: GncAccount[];
  transactions: GncTransaction[];
  prices: GncPrice[];
}

/** num/denom in millionths, rounded half away from zero, exactly (quantities can exceed 2^53 / 1e6). */
export function rationalToMicros(num: number, denom: number): number {
  if (!denom) return 0;
  const n = BigInt(Math.round(num)) * 1_000_000n;
  const d = BigInt(Math.round(denom));
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (2n * ad);
  return Number(neg ? -q : q);
}

/** The file isn't something we can import; the message is shown to the user. */
export class BookError extends Error {}

const SQLITE_MAGIC = "SQLite format 3\0";

/** Check the first bytes so XML books get a helpful message instead of a SQLite error. */
export async function checkFormat(path: string) {
  const head = new Uint8Array(await Bun.file(path).slice(0, 16).arrayBuffer());
  if (new TextDecoder().decode(head) === SQLITE_MAGIC) return;
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  const xml = new TextDecoder().decode(head).trimStart().startsWith("<?xml");
  if (gzip || xml) {
    throw new BookError(
      "This book is saved in GnuCash's XML format. In GnuCash, use File → Save As… and pick the sqlite3 data format, then upload that copy.",
    );
  }
  throw new BookError("That doesn't look like a GnuCash book. Upload a .gnucash file saved in the sqlite3 format.");
}

/**
 * GnuCash stores the posted date as a UTC timestamp: 10:59:00 UTC for newer books, local
 * midnight converted to UTC for older ones. Shifting by 12 hours lands on the intended calendar
 * day for every time zone in both cases. Older books use "YYYYMMDDHHMMSS".
 */
export function gnucashDate(raw: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})/.exec(raw);
  if (!m) throw new BookError(`Unrecognised date "${raw}" in the book`);
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!) + 12 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

function tableNames(db: Database) {
  return new Set(
    db
      .query<{ name: string }, []>("select name from sqlite_master where type = 'table'")
      .all()
      .map((r) => r.name),
  );
}

export function readBook(path: string): GncBook {
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    throw new BookError("Couldn't open the file as a SQLite database.");
  }
  try {
    const tables = tableNames(db);
    for (const t of ["books", "accounts", "transactions", "splits", "commodities"]) {
      if (!tables.has(t)) throw new BookError("That SQLite file isn't a GnuCash book (it has no GnuCash tables).");
    }

    const book = db.query<{ root: string }, []>("select root_account_guid as root from books limit 1").get();
    if (!book) throw new BookError("The book has no root account.");

    const commodityRows = db
      .query<{ guid: string; mnemonic: string; fullname: string | null; namespace: string | null }, []>(
        "select guid, mnemonic, fullname, namespace from commodities",
      )
      .all();
    const commodities = new Map(commodityRows.map((c) => [c.guid, c.mnemonic]));
    const commodityInfo = new Map(commodityRows.map((c) => [c.guid, c]));

    const rows = db
      .query<
        {
          guid: string;
          name: string;
          type: string;
          parent: string | null;
          commodity: string | null;
          placeholder: number | null;
          hidden: number | null;
        },
        []
      >(
        `select guid, name, account_type as type, parent_guid as parent, commodity_guid as commodity,
                placeholder, hidden
         from accounts`,
      )
      .all();
    const byGuid = new Map(rows.map((r) => [r.guid, r]));

    // Only accounts under the book's root count. Scheduled-transaction templates hang off a
    // separate template root and must not be imported.
    const accounts: GncAccount[] = [];
    const paths = new Map<string, string>();
    const pathOf = (guid: string): string | null => {
      if (guid === book.root) return "";
      const cached = paths.get(guid);
      if (cached !== undefined) return cached;
      const row = byGuid.get(guid);
      if (!row?.parent) return null;
      paths.set(guid, ""); // guards against cycles
      const parentPath = pathOf(row.parent);
      const path = parentPath === null ? null : parentPath ? `${parentPath}:${row.name}` : row.name;
      if (path === null) paths.delete(guid);
      else paths.set(guid, path);
      return path;
    };
    for (const r of rows) {
      if (r.guid === book.root) continue;
      const path = pathOf(r.guid);
      if (path === null) continue;
      accounts.push({
        guid: r.guid,
        name: r.name,
        path,
        type: r.type,
        parentGuid: r.parent === book.root ? null : r.parent,
        commodity: (r.commodity && commodities.get(r.commodity)) || "",
        commodityName: (r.commodity && commodityInfo.get(r.commodity)?.fullname) || "",
        commodityNamespace: (r.commodity && commodityInfo.get(r.commodity)?.namespace) || "",
        placeholder: !!r.placeholder,
        hidden: !!r.hidden,
      });
    }
    accounts.sort((a, b) => a.path.localeCompare(b.path));
    const inBook = new Set(accounts.map((a) => a.guid));

    const notes = new Map<string, string>();
    if (tables.has("slots")) {
      for (const r of db
        .query<{ guid: string; text: string | null }, []>(
          "select obj_guid as guid, string_val as text from slots where name = 'notes'",
        )
        .all()) {
        if (r.text) notes.set(r.guid, r.text);
      }
    }

    const splitRows = db
      .query<
        {
          guid: string;
          tx: string;
          account: string;
          memo: string | null;
          reconcile: string | null;
          vn: number;
          vd: number;
          qn: number;
          qd: number;
        },
        []
      >(
        `select guid, tx_guid as tx, account_guid as account, memo, reconcile_state as reconcile,
                value_num as vn, value_denom as vd, quantity_num as qn, quantity_denom as qd
         from splits`,
      )
      .all();
    const splitsByTx = new Map<string, GncSplit[]>();
    const outside = new Set<string>();
    for (const s of splitRows) {
      if (!inBook.has(s.account)) {
        outside.add(s.tx);
        continue;
      }
      const list = splitsByTx.get(s.tx) ?? [];
      list.push({
        guid: s.guid,
        accountGuid: s.account,
        memo: s.memo ?? "",
        reconcile: s.reconcile ?? "n",
        value: s.vd ? rationalToCents(s.vn, s.vd) : 0,
        quantity: s.qd ? rationalToCents(s.qn, s.qd) : 0,
        shares: rationalToMicros(s.qn, s.qd),
      });
      splitsByTx.set(s.tx, list);
    }

    const txRows = db
      .query<
        { guid: string; currency: string | null; num: string | null; date: string | null; description: string | null },
        []
      >("select guid, currency_guid as currency, num, post_date as date, description from transactions")
      .all();
    const transactions: GncTransaction[] = [];
    const currencyCount = new Map<string, number>();
    for (const t of txRows) {
      const splits = splitsByTx.get(t.guid);
      if (!splits || outside.has(t.guid) || !t.date) continue;
      const currency = (t.currency && commodities.get(t.currency)) || "";
      currencyCount.set(currency, (currencyCount.get(currency) ?? 0) + 1);
      transactions.push({
        guid: t.guid,
        date: gnucashDate(t.date),
        num: t.num ?? "",
        description: t.description ?? "",
        notes: notes.get(t.guid) ?? "",
        currency,
        splits,
      });
    }
    transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.guid.localeCompare(b.guid)));

    const currency = [...currencyCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";

    const bookPrices: GncPrice[] = [];
    if (tables.has("prices")) {
      for (const p of db
        .query<{ commodity: string; currency: string; date: string; vn: number; vd: number }, []>(
          "select commodity_guid as commodity, currency_guid as currency, date, value_num as vn, value_denom as vd from prices",
        )
        .all()) {
        const commodity = commodities.get(p.commodity);
        const cur = commodities.get(p.currency);
        if (!commodity || !cur || !p.date || !p.vd) continue;
        bookPrices.push({ commodity, currency: cur, date: gnucashDate(p.date), value: rationalToMicros(p.vn, p.vd) });
      }
    }
    return { currency, accounts, transactions, prices: bookPrices };
  } catch (err) {
    if (err instanceof BookError) throw err;
    throw new BookError(`Couldn't read the book: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db.close();
  }
}
