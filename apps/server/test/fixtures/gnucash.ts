import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

/** Builds a GnuCash book in the sqlite3 format, using GnuCash's own table definitions. */
export class BookBuilder {
  readonly db: Database;
  readonly root = guid();
  readonly templateRoot = guid();
  readonly usd = guid();
  private commodities = new Map<string, string>();

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec(`
      CREATE TABLE books (guid text(32) PRIMARY KEY NOT NULL, root_account_guid text(32) NOT NULL, root_template_guid text(32) NOT NULL);
      CREATE TABLE commodities (guid text(32) PRIMARY KEY NOT NULL, namespace text(2048) NOT NULL, mnemonic text(2048) NOT NULL,
        fullname text(2048), cusip text(2048), fraction integer NOT NULL, quote_flag integer NOT NULL, quote_source text(2048), quote_tz text(2048));
      CREATE TABLE accounts (guid text(32) PRIMARY KEY NOT NULL, name text(2048) NOT NULL, account_type text(2048) NOT NULL,
        commodity_guid text(32), commodity_scu integer NOT NULL, non_std_scu integer NOT NULL, parent_guid text(32),
        code text(2048), description text(2048), hidden integer, placeholder integer);
      CREATE TABLE transactions (guid text(32) PRIMARY KEY NOT NULL, currency_guid text(32) NOT NULL, num text(2048) NOT NULL,
        post_date text(19), enter_date text(19), description text(2048));
      CREATE TABLE splits (guid text(32) PRIMARY KEY NOT NULL, tx_guid text(32) NOT NULL, account_guid text(32) NOT NULL,
        memo text(2048) NOT NULL, action text(2048) NOT NULL, reconcile_state text(1) NOT NULL, reconcile_date text(19),
        value_num bigint NOT NULL, value_denom bigint NOT NULL, quantity_num bigint NOT NULL, quantity_denom bigint NOT NULL,
        lot_guid text(32));
      CREATE TABLE slots (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, obj_guid text(32) NOT NULL, name text(4096) NOT NULL,
        slot_type integer NOT NULL, int64_val bigint, string_val text(4096), double_val float8, timespec_val text(19),
        guid_val text(32), numeric_val_num bigint, numeric_val_denom bigint, gdate_val text(8));
      CREATE TABLE prices (guid text(32) PRIMARY KEY NOT NULL, commodity_guid text(32) NOT NULL, currency_guid text(32) NOT NULL,
        date text(19) NOT NULL, source text(2048), type text(2048), value_num bigint NOT NULL, value_denom bigint NOT NULL);
    `);
    this.commodity("USD", "CURRENCY", this.usd);
    this.db.run("INSERT INTO books VALUES (?, ?, ?)", [guid(), this.root, this.templateRoot]);
    this.db.run("INSERT INTO accounts VALUES (?, 'Root Account', 'ROOT', NULL, 0, 0, NULL, '', '', 0, 0)", [this.root]);
    this.db.run("INSERT INTO accounts VALUES (?, 'Template Root', 'ROOT', NULL, 0, 0, NULL, '', '', 0, 0)", [
      this.templateRoot,
    ]);
  }

  commodity(mnemonic: string, namespace = "NASDAQ", id = guid()) {
    this.db.run("INSERT INTO commodities VALUES (?, ?, ?, ?, '', 100, 0, NULL, NULL)", [
      id,
      namespace,
      mnemonic,
      mnemonic,
    ]);
    this.commodities.set(mnemonic, id);
    return id;
  }

  account(
    name: string,
    type: string,
    parent?: string,
    opts: { commodity?: string; placeholder?: boolean; hidden?: boolean } = {},
  ) {
    const id = guid();
    const commodity = this.commodities.get(opts.commodity ?? "USD") ?? this.commodity(opts.commodity!);
    this.db.run("INSERT INTO accounts VALUES (?, ?, ?, ?, 100, 0, ?, '', '', ?, ?)", [
      id,
      name,
      type,
      commodity,
      parent ?? this.root,
      opts.hidden ? 1 : 0,
      opts.placeholder ? 1 : 0,
    ]);
    return id;
  }

  /** Add a transaction. Split values are cents; `shares` overrides the quantity (whole shares). */
  tx(
    date: string,
    description: string,
    splits: { account: string; value: number; shares?: number; memo?: string; reconcile?: string }[],
    opts: { num?: string; notes?: string; postDate?: string } = {},
  ) {
    const id = guid();
    this.db.run("INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      this.usd,
      opts.num ?? "",
      opts.postDate ?? `${date} 10:59:00`,
      `${date} 12:00:00`,
      description,
    ]);
    for (const s of splits) {
      const [qn, qd] = s.shares !== undefined ? [s.shares, 1] : [s.value, 100];
      this.db.run("INSERT INTO splits VALUES (?, ?, ?, ?, '', ?, NULL, ?, 100, ?, ?, NULL)", [
        guid(),
        id,
        s.account,
        s.memo ?? "",
        s.reconcile ?? "n",
        s.value,
        qn,
        qd,
      ]);
    }
    if (opts.notes) {
      this.db.run("INSERT INTO slots (obj_guid, name, slot_type, string_val) VALUES (?, 'notes', 4, ?)", [
        id,
        opts.notes,
      ]);
    }
    return id;
  }

  bytes() {
    return this.db.serialize();
  }
}

export function guid() {
  return randomBytes(16).toString("hex");
}

/**
 * The sample book used by the importer tests: bank, savings, a credit card, a brokerage with a
 * stock, a 401k, income and nested expense accounts, and transactions covering opening balances,
 * splits, transfers, a multi-account paycheck, buys, sells, a dividend, a voided entry, an
 * Imbalance entry, a category-only move, both date formats, and a scheduled-transaction template.
 */
export function sampleBook() {
  const b = new BookBuilder();
  const assets = b.account("Assets", "ASSET", undefined, { placeholder: true });
  const current = b.account("Current Assets", "ASSET", assets, { placeholder: true });
  const checking = b.account("Checking", "BANK", current);
  const savings = b.account("Savings Account", "BANK", current);
  const brokerage = b.account("Brokerage", "ASSET", assets);
  const aapl = b.account("AAPL", "STOCK", brokerage, { commodity: "AAPL" });
  const k401 = b.account("401k", "ASSET", assets);
  const liabilities = b.account("Liabilities", "LIABILITY", undefined, { placeholder: true });
  const visa = b.account("Visa", "CREDIT", liabilities);
  const income = b.account("Income", "INCOME", undefined, { placeholder: true });
  const salary = b.account("Salary", "INCOME", income);
  const dividends = b.account("Dividends", "INCOME", income);
  const expenses = b.account("Expenses", "EXPENSE", undefined, { placeholder: true });
  const groceries = b.account("Groceries", "EXPENSE", expenses);
  const household = b.account("Household", "EXPENSE", expenses);
  const auto = b.account("Auto", "EXPENSE", expenses, { placeholder: true });
  const fuel = b.account("Fuel", "EXPENSE", auto);
  const taxes = b.account("Taxes", "EXPENSE", expenses, { placeholder: true });
  const federal = b.account("Federal", "EXPENSE", taxes);
  const equity = b.account("Equity", "EQUITY", undefined, { placeholder: true });
  const opening = b.account("Opening Balances", "EQUITY", equity);
  const imbalance = b.account("Imbalance-USD", "BANK");

  const t = {
    opening: b.tx("2026-01-01", "Opening Balance", [
      { account: checking, value: 500000, reconcile: "y" },
      { account: savings, value: 1000000, reconcile: "y" },
      { account: opening, value: -1500000 },
    ]),
    groceries: b.tx(
      "2026-01-05",
      "Corner Grocer",
      [
        { account: checking, value: -8250, memo: "debit card", reconcile: "y" },
        { account: groceries, value: 8250 },
      ],
      { num: "1001", notes: "weekly shop" },
    ),
    bigBox: b.tx("2026-01-06", "Big Box Store", [
      { account: visa, value: -12000, reconcile: "c" },
      { account: groceries, value: 8000, memo: "food" },
      { account: household, value: 4000, memo: "cleaning" },
    ]),
    transfer: b.tx("2026-01-10", "Move to savings", [
      { account: checking, value: -100000 },
      { account: savings, value: 100000 },
    ]),
    paycheck: b.tx("2026-01-15", "Acme Corp", [
      { account: salary, value: -300000 },
      { account: federal, value: 60000 },
      { account: k401, value: 30000 },
      { account: checking, value: 210000 },
    ]),
    payVisa: b.tx("2026-01-20", "Visa payment", [
      { account: checking, value: -12000 },
      { account: visa, value: 12000 },
    ]),
    fuel: b.tx("2026-01-25", "Gas Station", [
      { account: visa, value: -4567 },
      { account: fuel, value: 4567 },
    ]),
    buy: b.tx("2026-02-01", "Buy AAPL", [
      { account: brokerage, value: -100000 },
      { account: aapl, value: 100000, shares: 5 },
    ]),
    dividend: b.tx("2026-02-15", "AAPL dividend", [
      { account: dividends, value: -1234 },
      { account: brokerage, value: 1234 },
    ]),
    sell: b.tx("2026-03-01", "Sell AAPL", [
      { account: aapl, value: -65000, shares: -2 },
      { account: brokerage, value: 65000 },
    ]),
    voided: b.tx("2026-03-05", "Voided cheque", [
      { account: checking, value: 0, reconcile: "v" },
      { account: groceries, value: 0, reconcile: "v" },
    ]),
    imbalance: b.tx(
      "2026-03-06",
      "Mystery",
      [
        { account: checking, value: -1000 },
        { account: imbalance, value: 1000 },
      ],
      { postDate: "20260306105900" },
    ),
    reclass: b.tx("2026-03-07", "Reclassify", [
      { account: groceries, value: -500 },
      { account: household, value: 500 },
    ]),
    // An older book stores local midnight converted to UTC (here UTC-5).
    oldStyle: b.tx(
      "2026-03-10",
      "Corner Grocer",
      [
        { account: checking, value: -2000 },
        { account: groceries, value: 2000 },
      ],
      { postDate: "2026-03-10 05:00:00" },
    ),
  };

  // A scheduled-transaction template, which must never be imported.
  const templateAccount = b.account("template", "BANK", b.templateRoot);
  b.tx("2026-04-01", "Rent (scheduled)", [
    { account: templateAccount, value: -150000 },
    { account: templateAccount, value: 150000 },
  ]);

  const accounts = {
    checking,
    savings,
    brokerage,
    aapl,
    k401,
    visa,
    salary,
    dividends,
    groceries,
    household,
    fuel,
    federal,
    opening,
    imbalance,
  };
  return { builder: b, accounts, tx: t };
}
