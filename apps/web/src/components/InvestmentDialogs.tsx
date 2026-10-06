import {
  INVESTMENT_ACTIONS,
  INVESTMENT_ACTION_LABELS,
  SECURITY_TYPES,
  SECURITY_TYPE_LABELS,
  centsToInput,
  formatCents,
  parseCents,
  parsePrice,
  parseShares,
  priceToString,
  sharesToString,
  sharesValueCents,
  type Account,
  type InvestmentAction,
  type InvestmentTxn,
  type Security,
  type SecurityLookup,
  type SecurityType,
} from "@fd/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { today, useLedgerMutation } from "../ledger";
import { Dialog } from "./Dialog";

const NEEDS_SHARES: InvestmentAction[] = ["buy", "sell", "reinvest", "transfer_in", "transfer_out"];
const NEEDS_PRICE: InvestmentAction[] = ["buy", "sell", "reinvest"];

export function InvestmentTxnDialog(props: {
  txn?: InvestmentTxn;
  accounts: Account[];
  securities: Security[];
  defaults?: { accountId?: number; securityId?: number };
  onClose: () => void;
  onAddSecurity: () => void;
}) {
  const t = props.txn;
  const [accountId, setAccountId] = useState(t?.accountId ?? props.defaults?.accountId ?? props.accounts[0]?.id ?? 0);
  const [securityId, setSecurityId] = useState(
    t?.securityId ?? props.defaults?.securityId ?? props.securities[0]?.id ?? 0,
  );
  const [action, setAction] = useState<InvestmentAction>(t?.action ?? "buy");
  const [date, setDate] = useState(t?.date ?? today());
  const [shares, setShares] = useState(t && t.action !== "split" && t.shares ? sharesToString(Math.abs(t.shares)) : "");
  const [price, setPrice] = useState(t?.price ? priceToString(t.price) : "");
  const [fees, setFees] = useState(t?.fees ? centsToInput(t.fees) : "");
  const [amount, setAmount] = useState(
    t && (t.action === "dividend" || t.action === "transfer_in") ? centsToInput(t.amount) : "",
  );
  const [total, setTotal] = useState("");
  const [splitNew, setSplitNew] = useState(String(t?.splitNew ?? 2));
  const [splitOld, setSplitOld] = useState(String(t?.splitOld ?? 1));
  const [notes, setNotes] = useState(t?.action === "split" ? "" : (t?.notes ?? ""));
  const [error, setError] = useState<string | null>(null);

  const save = useLedgerMutation((body: unknown) =>
    t ? api.put(`/investments/transactions/${t.id}`, body) : api.post("/investments/transactions", body),
  );
  const remove = useLedgerMutation(() => api.delete(`/investments/transactions/${t!.id}`));

  const sharesMicro = shares.trim() ? parseShares(shares) : undefined;
  const priceMicros = price.trim() ? parsePrice(price) : undefined;
  const feeCents = fees.trim() ? parseCents(fees) : 0;
  const gross = sharesMicro && priceMicros ? sharesValueCents(sharesMicro, priceMicros) : null;
  const computed =
    gross === null || feeCents === null
      ? null
      : action === "buy"
        ? gross + feeCents
        : action === "sell"
          ? gross - feeCents
          : gross;

  function submit() {
    const body: Record<string, unknown> = { accountId, securityId, date, action, notes };
    if (!accountId) return setError("Pick an account");
    if (!securityId) return setError("Pick a security");
    if (NEEDS_SHARES.includes(action)) {
      if (!sharesMicro) return setError("Enter the number of shares, like 12.5");
      body.shares = sharesMicro;
    }
    if (NEEDS_PRICE.includes(action)) {
      if (!priceMicros) return setError("Enter the price per share, like 101.25");
      body.price = priceMicros;
    }
    if (action === "buy" || action === "sell") {
      if (feeCents === null || feeCents < 0) return setError("Enter fees as an amount, like 4.95");
      body.fees = feeCents;
      if (total.trim()) {
        const exact = parseCents(total);
        if (exact === null || exact < 0) return setError("Enter the total as an amount, like 1,234.56");
        body.amount = exact;
      }
    }
    if (action === "dividend" || action === "transfer_in") {
      const cents = parseCents(amount);
      if (cents === null || cents < 0 || (action === "dividend" && cents === 0)) {
        return setError(action === "dividend" ? "Enter the dividend amount" : "Enter the cost basis");
      }
      body.amount = cents;
    }
    if (action === "split") {
      body.splitNew = Number(splitNew);
      body.splitOld = Number(splitOld);
      if (!Number.isInteger(body.splitNew) || !Number.isInteger(body.splitOld) || !splitNew || !splitOld) {
        return setError("Enter the split ratio as whole numbers, like 2 for 1");
      }
    }
    setError(null);
    save.mutate(body, { onSuccess: props.onClose });
  }

  return (
    <Dialog
      title={t ? "Edit investment transaction" : "Add investment transaction"}
      submitLabel={t ? "Save" : "Add"}
      onClose={props.onClose}
      onSubmit={submit}
      pending={save.isPending}
      error={error ?? save.error?.message ?? remove.error?.message}
    >
      <div className="field-row">
        <label className="field">
          <span>Account</span>
          <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
            {props.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value as InvestmentAction)}>
            {INVESTMENT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {INVESTMENT_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>
            Security{" "}
            <button type="button" className="link-button field-link" onClick={props.onAddSecurity}>
              add new
            </button>
          </span>
          <select aria-label="Security" value={securityId} onChange={(e) => setSecurityId(Number(e.target.value))}>
            {props.securities.length === 0 && <option value={0}>Add a security first</option>}
            {props.securities.map((s) => (
              <option key={s.id} value={s.id}>
                {s.symbol}: {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(NEEDS_SHARES.includes(action) || NEEDS_PRICE.includes(action)) && (
        <div className="field-row">
          <label className="field">
            <span>Shares</span>
            <input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" placeholder="0" />
          </label>
          {NEEDS_PRICE.includes(action) && (
            <label className="field">
              <span>Price per share</span>
              <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.00" />
            </label>
          )}
          {action === "transfer_in" && (
            <label className="field">
              <span>Cost basis</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
              />
            </label>
          )}
        </div>
      )}
      {(action === "buy" || action === "sell") && (
        <div className="field-row">
          <label className="field">
            <span>Fees</span>
            <input value={fees} onChange={(e) => setFees(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </label>
          <label className="field">
            <span>{action === "buy" ? "Total paid" : "Total received"}</span>
            <input
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              inputMode="decimal"
              placeholder={computed !== null ? centsToInput(computed) : "0.00"}
            />
          </label>
        </div>
      )}
      {action === "dividend" && (
        <label className="field">
          <span>Amount received</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
      )}
      {action === "split" && (
        <div className="field-row">
          <label className="field">
            <span>New shares</span>
            <input value={splitNew} onChange={(e) => setSplitNew(e.target.value)} inputMode="numeric" />
          </label>
          <label className="field">
            <span>For every old shares</span>
            <input value={splitOld} onChange={(e) => setSplitOld(e.target.value)} inputMode="numeric" />
          </label>
        </div>
      )}
      {(action === "buy" || action === "sell") && computed !== null && !total.trim() && (
        <small className="muted">
          {action === "buy" ? "Cash out" : "Cash in"}: {formatCents(computed)}. Enter the total from your statement if
          it differs.
        </small>
      )}
      {action === "reinvest" && <small className="muted">A dividend used to buy shares: no cash moves.</small>}
      <label className="field">
        <span>Notes</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </label>
      {t && (
        <button
          type="button"
          className="link-button danger"
          onClick={() => {
            if (confirm("Delete this investment transaction? Its cash entry in the register is deleted too.")) {
              remove.mutate(undefined, { onSuccess: props.onClose });
            }
          }}
        >
          Delete this transaction
        </button>
      )}
    </Dialog>
  );
}

export function SecurityDialog(props: { security?: Security; onClose: (created?: Security) => void }) {
  const s = props.security;
  const [symbol, setSymbol] = useState(s?.symbol ?? "");
  const [name, setName] = useState(s?.name ?? "");
  const [type, setType] = useState<SecurityType>(s?.type ?? "etf");
  const [autoPrice, setAutoPrice] = useState(s?.autoPrice ?? true);
  const [priceDate, setPriceDate] = useState(today());
  const [manual, setManual] = useState("");
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useLedgerMutation((body: unknown) =>
    s
      ? api.patch<Security>(`/investments/securities/${s.id}`, body)
      : api.post<Security>("/investments/securities", body),
  );
  const remove = useLedgerMutation(() => api.delete(`/investments/securities/${s!.id}`));
  const addPrice = useLedgerMutation((body: unknown) => api.post(`/investments/securities/${s!.id}/prices`, body));
  const lookup = useMutation({
    mutationFn: (sym: string) =>
      api.get<SecurityLookup>(`/investments/securities/lookup?symbol=${encodeURIComponent(sym)}`),
  });

  function findSymbol() {
    if (!symbol.trim()) return;
    lookup.mutate(symbol.trim(), {
      onSuccess: (found) => {
        setSymbol(found.symbol);
        setName(found.name);
        setType(found.type);
        setLookupNote(found.price ? `Last price ${found.currency} ${priceToString(found.price)}` : null);
      },
      onError: () => setLookupNote("Not found. You can still add it and enter prices yourself."),
    });
  }

  return (
    <Dialog
      title={s ? `Edit ${s.symbol}` : "Add a security"}
      submitLabel={s ? "Save" : "Add security"}
      onClose={() => props.onClose()}
      onSubmit={() => {
        setError(null);
        save.mutate(
          { symbol, name, type, autoPrice },
          { onSuccess: (created) => props.onClose(s ? undefined : created) },
        );
      }}
      pending={save.isPending}
      error={error ?? save.error?.message ?? remove.error?.message ?? addPrice.error?.message}
    >
      <div className="field-row">
        <label className="field">
          <span>Ticker symbol</span>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onBlur={() => !s && !name && findSymbol()}
            placeholder="VTI"
            autoFocus={!s}
            required
            maxLength={24}
          />
        </label>
        <div className="field">
          <span aria-hidden>&nbsp;</span>
          <button type="button" className="btn" onClick={findSymbol} disabled={lookup.isPending}>
            {lookup.isPending ? "Looking up…" : "Look up"}
          </button>
        </div>
      </div>
      {lookupNote && <small className="muted">{lookupNote}</small>}
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </label>
      <label className="field">
        <span>Type</span>
        <select value={type} onChange={(e) => setType(e.target.value as SecurityType)}>
          {SECURITY_TYPES.map((x) => (
            <option key={x} value={x}>
              {SECURITY_TYPE_LABELS[x]}
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={autoPrice} onChange={(e) => setAutoPrice(e.target.checked)} />
        <span>
          Fetch prices automatically <small className="muted">(daily, from Yahoo Finance)</small>
        </span>
      </label>
      {s && (
        <div className="manual-price">
          <strong>Enter a price</strong>
          <div className="field-row">
            <input
              type="date"
              aria-label="Price date"
              value={priceDate}
              onChange={(e) => setPriceDate(e.target.value)}
            />
            <input
              aria-label="Price"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
          </div>
          <button
            type="button"
            className="btn btn-small"
            disabled={addPrice.isPending}
            onClick={() => {
              const micros = parsePrice(manual);
              if (!micros) return setError("Enter a price, like 101.25");
              setError(null);
              addPrice.mutate({ date: priceDate, price: micros }, { onSuccess: () => setManual("") });
            }}
          >
            Save price
          </button>
          {addPrice.isSuccess && <small className="positive">Saved.</small>}
        </div>
      )}
      {s && (
        <button
          type="button"
          className="link-button danger"
          onClick={() => {
            if (confirm(`Delete ${s.symbol} and its price history?`))
              remove.mutate(undefined, { onSuccess: () => props.onClose() });
          }}
        >
          Delete security
        </button>
      )}
    </Dialog>
  );
}
