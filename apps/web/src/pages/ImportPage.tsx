import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  SECURITY_TYPES,
  SECURITY_TYPE_LABELS,
  centsToInput,
  formatCents,
  type Account,
  type AccountType,
  type CategoryGroup,
  type GnucashAccountInfo,
  type GnucashMapping,
  type GnucashPreview,
  type GnucashUpload,
  type ImportBatch,
  type Security,
  type SecurityType,
} from "@fd/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { BankImport } from "../components/BankImport";
import { formatDate, useAccounts, useCategories, useLedgerMutation, useSecurities } from "../ledger";

const CATEGORY_TYPES = new Set(["INCOME", "EXPENSE"]);
const SOURCE_LABELS: Record<string, string> = { gnucash: "GnuCash", ofx: "OFX", csv: "CSV" };

/** Encodes a mapping as the value of the "Import as" select. */
function choiceOf(m: GnucashMapping) {
  if (m.kind === "account") return m.accountId ? `account:${m.accountId}` : "new-account";
  if (m.kind === "category") return m.categoryId ? `category:${m.categoryId}` : "new-category";
  if (m.kind === "holding") return m.securityId ? `security:${m.securityId}` : "new-holding";
  return m.kind;
}

function leafName(path: string) {
  return path.split(":").at(-1) ?? path;
}

/** Default names for a new category, matching the server: Expenses:Auto:Fuel -> Auto / Fuel. */
function categoryNames(path: string) {
  const [top = path, ...rest] = path.split(":");
  if (rest.length === 0) return { groupName: top, name: top };
  if (rest.length === 1) return { groupName: top, name: rest[0]! };
  return { groupName: rest[0]!, name: rest.slice(1).join(": ") };
}

function mappingFor(
  choice: string,
  info: GnucashAccountInfo,
  current: GnucashMapping,
  accounts: Account[],
  groups: CategoryGroup[],
  securities: Security[],
): GnucashMapping {
  const [kind, id] = choice.split(":");
  if (kind === "opening" || kind === "skip") return { kind };
  if (kind === "new-holding" || kind === "security") {
    const existing = kind === "security" ? securities.find((x) => x.id === Number(id)) : undefined;
    const base = info.suggested.kind === "holding" ? info.suggested : null;
    return {
      kind: "holding",
      securityId: existing?.id ?? null,
      symbol:
        existing?.symbol ??
        base?.symbol ??
        leafName(info.path)
          .toUpperCase()
          .replace(/[^A-Z0-9.\-^=]/g, "")
          .slice(0, 24),
      name: existing?.name ?? base?.name ?? leafName(info.path),
      type: existing?.type ?? base?.type ?? "stock",
    };
  }
  if (kind === "new-account") {
    const base = current.kind === "account" ? current : info.suggested.kind === "account" ? info.suggested : null;
    return {
      kind: "account",
      accountId: null,
      name: base?.accountId ? leafName(info.path).slice(0, 100) : (base?.name ?? leafName(info.path).slice(0, 100)),
      type: base?.type ?? "asset",
      onBudget: base?.onBudget ?? false,
    };
  }
  if (kind === "account") {
    const a = accounts.find((x) => x.id === Number(id))!;
    return { kind: "account", accountId: a.id, name: a.name, type: a.type, onBudget: a.onBudget };
  }
  const isIncome = info.type === "INCOME";
  if (kind === "new-category") {
    const names = current.kind === "category" && !current.categoryId ? current : categoryNames(info.path);
    return { kind: "category", categoryId: null, groupName: names.groupName, name: names.name, isIncome };
  }
  const group = groups.find((g) => g.categories.some((c) => c.id === Number(id)))!;
  const category = group.categories.find((c) => c.id === Number(id))!;
  return {
    kind: "category",
    categoryId: category.id,
    groupName: group.name,
    name: category.name,
    isIncome: group.isIncome,
  };
}

function MappingRow(props: {
  info: GnucashAccountInfo;
  mapping: GnucashMapping;
  onChange: (m: GnucashMapping) => void;
  accounts: Account[];
  groups: CategoryGroup[];
  securities: Security[];
  /** The book's currency; other commodities show as quantities. */
  currency: string;
}) {
  const { info, mapping: m } = props;
  const isCategoryType = CATEGORY_TYPES.has(info.type);
  const depth = info.path.split(":").length - 1;

  return (
    <div className={info.splitCount ? "map-row" : "map-row empty"}>
      <div className="map-source" style={{ paddingLeft: depth * 14 }}>
        <span className="truncate" title={info.path}>
          {leafName(info.path)}
        </span>
        <span className="badge">{info.type}</span>
        {info.remembered && (
          <span className="badge remembered" title="Mapped this way in your last import">
            remembered
          </span>
        )}
      </div>
      <div className="map-count muted">{info.splitCount ? `${info.splitCount} splits` : "unused"}</div>
      <div className="map-balance">
        {!info.splitCount
          ? ""
          : info.commodity && info.commodity !== props.currency
            ? `${centsToInput(info.balance)} ${info.commodity}`
            : formatCents(info.balance)}
      </div>
      <div className="map-target">
        <select
          aria-label={`Import ${info.path} as`}
          value={choiceOf(m)}
          onChange={(e) =>
            props.onChange(mappingFor(e.target.value, info, m, props.accounts, props.groups, props.securities))
          }
        >
          <option value="new-account">New account</option>
          <option value="new-category">New category</option>
          {isCategoryType ? null : <option value="new-holding">Investment holding (new security)</option>}
          {isCategoryType ? null : <option value="opening">Opening balances (equity)</option>}
          <option value="skip">Skip</option>
          {props.accounts.length > 0 && (
            <optgroup label="Existing account">
              {props.accounts.map((a) => (
                <option key={a.id} value={`account:${a.id}`}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
          {!isCategoryType && props.securities.length > 0 && (
            <optgroup label="Existing security">
              {props.securities.map((x) => (
                <option key={x.id} value={`security:${x.id}`}>
                  {x.symbol}: {x.name}
                </option>
              ))}
            </optgroup>
          )}
          {props.groups.map((g) => (
            <optgroup key={g.id} label={`Category: ${g.name}`}>
              {g.categories.map((c) => (
                <option key={c.id} value={`category:${c.id}`}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {m.kind === "account" && m.accountId === null && (
          <div className="map-details">
            <input
              aria-label="New account name"
              value={m.name}
              maxLength={100}
              onChange={(e) => props.onChange({ ...m, name: e.target.value })}
            />
            <select
              aria-label="Account type"
              value={m.type}
              onChange={(e) => props.onChange({ ...m, type: e.target.value as AccountType })}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACCOUNT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <label className="checkbox inline">
              <input
                type="checkbox"
                checked={m.onBudget}
                onChange={(e) => props.onChange({ ...m, onBudget: e.target.checked })}
              />
              <span>On budget</span>
            </label>
          </div>
        )}
        {m.kind === "holding" && m.securityId === null && (
          <div className="map-details">
            <input
              aria-label="Ticker symbol"
              value={m.symbol}
              maxLength={24}
              onChange={(e) => props.onChange({ ...m, symbol: e.target.value.toUpperCase() })}
            />
            <input
              aria-label="Security name"
              value={m.name}
              maxLength={120}
              onChange={(e) => props.onChange({ ...m, name: e.target.value })}
            />
            <select
              aria-label="Security type"
              value={m.type}
              onChange={(e) => props.onChange({ ...m, type: e.target.value as SecurityType })}
            >
              {SECURITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SECURITY_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
        )}
        {m.kind === "holding" && (
          <small className="muted">Held in the account its parent GnuCash account is imported into.</small>
        )}
        {m.kind === "category" && m.categoryId === null && (
          <div className="map-details">
            <input
              aria-label="Category group"
              value={m.groupName}
              maxLength={100}
              onChange={(e) => props.onChange({ ...m, groupName: e.target.value })}
            />
            <input
              aria-label="Category name"
              value={m.name}
              maxLength={100}
              onChange={(e) => props.onChange({ ...m, name: e.target.value })}
            />
            <label className="checkbox inline">
              <input
                type="checkbox"
                checked={m.isIncome}
                onChange={(e) => props.onChange({ ...m, isIncome: e.target.checked })}
              />
              <span>Income</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewPanel(props: { preview: GnucashPreview; stale: boolean }) {
  const p = props.preview;
  const mismatches = p.balances.filter((b) => b.gnucash !== b.afterImport);
  return (
    <section className={props.stale ? "card import-preview stale" : "card import-preview"}>
      <h2>What will happen</h2>
      <ul className="import-stats">
        <li>
          <strong>{p.transactions}</strong> GnuCash transaction{p.transactions === 1 ? "" : "s"} to import:{" "}
          {p.rows.transactions} transaction{p.rows.transactions === 1 ? "" : "s"}, {p.rows.transfers} transfer
          {p.rows.transfers === 1 ? "" : "s"}, {p.rows.splits} split line{p.rows.splits === 1 ? "" : "s"}
        </li>
        {p.alreadyImported > 0 && <li>{p.alreadyImported} already imported earlier (skipped)</li>}
        {p.noAccount > 0 && <li>{p.noAccount} only move money between categories or skipped accounts (skipped)</li>}
        {p.voided > 0 && <li>{p.voided} voided (skipped)</li>}
        {p.newAccounts.length > 0 && <li>New accounts: {p.newAccounts.join(", ")}</li>}
        {p.newCategories.length > 0 && <li>New categories: {p.newCategories.join(", ")}</li>}
        {p.investments > 0 && (
          <li>
            {p.investments} investment transaction{p.investments === 1 ? "" : "s"} (buys, sells and splits)
            {p.prices > 0 && `, plus ${p.prices} price${p.prices === 1 ? "" : "s"} from the book`}
          </li>
        )}
        {p.newSecurities.length > 0 && <li>New securities: {p.newSecurities.join(", ")}</li>}
      </ul>
      {p.warnings.length > 0 && (
        <ul className="import-warnings">
          {p.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {p.balances.length > 0 && (
        <>
          <h3>Balance check</h3>
          <table className="activity-table">
            <thead>
              <tr>
                <th>Account</th>
                <th className="amount">GnuCash</th>
                <th className="amount">After import</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.balances.map((b) => (
                <tr key={`${b.accountId}-${b.name}`}>
                  <td>{b.name}</td>
                  <td className="amount">{formatCents(b.gnucash)}</td>
                  <td className="amount">{formatCents(b.afterImport)}</td>
                  <td className={b.gnucash === b.afterImport ? "positive" : "negative"}>
                    {b.gnucash === b.afterImport ? "✓" : `off by ${formatCents(b.afterImport - b.gnucash)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {mismatches.length > 0 && (
            <p className="muted">
              Differences usually mean the account already had transactions here, or that some of its GnuCash
              transactions were deleted after an earlier import.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Batches() {
  const qc = useQueryClient();
  const batches = useQuery({
    queryKey: ["import", "batches"],
    queryFn: () => api.get<ImportBatch[]>("/import/batches"),
  });
  const undo = useLedgerMutation((id: number) => api.post(`/import/batches/${id}/undo`));
  if (!batches.data?.length) return null;
  return (
    <section className="card">
      <h2>Past imports</h2>
      {undo.error && <p className="error-text">{undo.error.message}</p>}
      <table className="activity-table">
        <thead>
          <tr>
            <th>When</th>
            <th>File</th>
            <th>Type</th>
            <th>By</th>
            <th className="amount">Transactions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {batches.data.map((b) => (
            <tr key={b.id} className={b.undoneAt ? "muted" : undefined}>
              <td>{formatDate(b.createdAt.slice(0, 10))}</td>
              <td>{b.fileName}</td>
              <td>{SOURCE_LABELS[b.source] ?? b.source}</td>
              <td>{b.createdBy}</td>
              <td className="amount">{b.transactionCount}</td>
              <td className="amount">
                {b.undoneAt ? (
                  "Undone"
                ) : (
                  <button
                    className="link-button danger"
                    disabled={undo.isPending}
                    onClick={() => {
                      const msg = `Undo this import? Its ${b.transactionCount} transactions are deleted, along with any accounts, categories and payees it created that nothing else uses.`;
                      if (confirm(msg)) {
                        undo.mutate(b.id, { onSuccess: () => qc.invalidateQueries({ queryKey: ["import"] }) });
                      }
                    }}
                  >
                    Undo
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ImportPage() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const categories = useCategories();
  const securities = useSecurities();
  const [upload, setUpload] = useState<GnucashUpload | null>(null);
  const [mappings, setMappings] = useState<Record<string, GnucashMapping>>({});
  const [showEmpty, setShowEmpty] = useState(false);
  const [debounced, setDebounced] = useState(mappings);

  const send = useMutation({
    mutationFn: (file: File) =>
      api.upload<GnucashUpload>(`/import/gnucash?name=${encodeURIComponent(file.name)}`, file),
    onSuccess: (u) => {
      setUpload(u);
      const initial = Object.fromEntries(u.accounts.map((a) => [a.guid, a.suggested]));
      setMappings(initial);
      setDebounced(initial);
    },
  });

  useEffect(() => {
    const t = setTimeout(() => setDebounced(mappings), 400);
    return () => clearTimeout(t);
  }, [mappings]);

  const preview = useQuery({
    queryKey: ["import", "preview", upload?.uploadId, debounced],
    queryFn: () => api.post<GnucashPreview>(`/import/gnucash/${upload!.uploadId}/preview`, { mappings: debounced }),
    enabled: !!upload,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const commit = useLedgerMutation(() =>
    api.post<{ batchId: number; preview: GnucashPreview }>(`/import/gnucash/${upload!.uploadId}/commit`, { mappings }),
  );

  const sections = useMemo(() => {
    const list = (upload?.accounts ?? []).filter((a) => showEmpty || a.splitCount > 0);
    return [
      { title: "Accounts", items: list.filter((a) => !CATEGORY_TYPES.has(a.type)) },
      { title: "Income and expenses", items: list.filter((a) => CATEGORY_TYPES.has(a.type)) },
    ];
  }, [upload, showEmpty]);

  function reset() {
    setUpload(null);
    send.reset();
    commit.reset();
    void qc.invalidateQueries({ queryKey: ["import"] });
  }

  if (commit.data) {
    const p = commit.data.preview;
    return (
      <>
        <header className="page-header">
          <h1>Import</h1>
        </header>
        <div className="page-body">
          <section className="card">
            <h2>Import complete</h2>
            <p>
              Imported {p.transactions} GnuCash transaction{p.transactions === 1 ? "" : "s"}
              {p.newAccounts.length
                ? ` into ${p.newAccounts.length} new account${p.newAccounts.length === 1 ? "" : "s"}`
                : ""}
              . Your accounts are in the sidebar.
            </p>
            <div className="row-actions">
              <Link className="btn btn-primary" to="/budget">
                Go to the budget
              </Link>
              <button className="btn" onClick={reset}>
                Import another file
              </button>
            </div>
          </section>
          <Batches />
        </div>
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <h1>Import</h1>
      </header>
      <div className="page-body">
        {!upload && <BankImport />}
        {!upload && (
          <section className="card">
            <h2>GnuCash book</h2>
            <p className="muted">
              Upload a <strong>copy</strong> of your GnuCash book saved in the <strong>sqlite3</strong> format (in
              GnuCash: File → Save As…, data format “sqlite3”). Nothing is saved until you review the mapping and
              confirm. You can import the same book again later: only new transactions are added.
            </p>
            <input
              type="file"
              accept=".gnucash,.sqlite,.sqlite3,.db"
              aria-label="GnuCash book"
              disabled={send.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) send.mutate(file);
              }}
            />
            {send.isPending && <p className="muted">Reading the book…</p>}
            {send.error && <p className="error-text">{send.error.message}</p>}
          </section>
        )}

        {upload && (
          <>
            <section className="card wide">
              <div className="import-summary">
                <div>
                  <h2>{upload.fileName}</h2>
                  <p className="muted">
                    {upload.transactionCount} transactions
                    {upload.firstDate && ` from ${formatDate(upload.firstDate)} to ${formatDate(upload.lastDate!)}`}, in{" "}
                    {upload.currency}.
                  </p>
                </div>
                <button className="btn" onClick={reset}>
                  Choose a different file
                </button>
              </div>
              <p className="muted">
                Choose what each GnuCash account becomes. Bank, card and asset accounts become accounts; income and
                expense accounts become budget categories; stock and fund accounts become investment holdings; equity is
                treated as opening balances.
              </p>
              <label className="checkbox inline">
                <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
                <span>Show accounts with no transactions</span>
              </label>
              {sections.map(
                (s) =>
                  s.items.length > 0 && (
                    <div key={s.title} className="map-section">
                      <h3>{s.title}</h3>
                      {s.items.map((info) => (
                        <MappingRow
                          key={info.guid}
                          info={info}
                          mapping={mappings[info.guid]!}
                          onChange={(m) => setMappings((prev) => ({ ...prev, [info.guid]: m }))}
                          accounts={accounts.data ?? []}
                          groups={categories.data ?? []}
                          securities={securities.data ?? []}
                          currency={upload.currency}
                        />
                      ))}
                    </div>
                  ),
              )}
            </section>

            {preview.error && <p className="error-text">{preview.error.message}</p>}
            {preview.data && (
              <PreviewPanel preview={preview.data} stale={preview.isFetching || debounced !== mappings} />
            )}

            <div className="row-actions">
              <button
                className="btn btn-primary"
                disabled={
                  !preview.data ||
                  preview.isFetching ||
                  debounced !== mappings ||
                  !!preview.error ||
                  commit.isPending ||
                  preview.data.transactions === 0
                }
                onClick={() =>
                  commit.mutate(undefined, {
                    onSuccess: () => qc.invalidateQueries({ queryKey: ["import", "batches"] }),
                  })
                }
              >
                {commit.isPending
                  ? "Importing…"
                  : preview.data?.transactions === 0
                    ? "Nothing new to import"
                    : `Import ${preview.data?.transactions ?? ""} transactions`}
              </button>
              {commit.error && <span className="error-text">{commit.error.message}</span>}
            </div>
          </>
        )}

        <Batches />
      </div>
    </>
  );
}
