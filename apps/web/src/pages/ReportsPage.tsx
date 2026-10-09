import {
  addMonths,
  formatCents,
  formatMonth,
  type CashFlowMonth,
  type NetWorthPoint,
  type SpendingRow,
} from "@fd/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { CashFlowChart, NetWorthChart, SpendingBars } from "../components/ReportCharts";
import { thisMonth } from "../ledger";

type Tab = "net-worth" | "cash-flow" | "spending";
const TABS: [Tab, string][] = [
  ["net-worth", "Net worth"],
  ["cash-flow", "Cash flow"],
  ["spending", "Spending"],
];

/** Month ranges, inclusive, relative to the current month. */
function presets(now: string) {
  const year = now.slice(0, 4);
  return {
    "this-month": { label: "This month", from: now, to: now },
    "last-month": { label: "Last month", from: addMonths(now, -1), to: addMonths(now, -1) },
    "3m": { label: "Last 3 months", from: addMonths(now, -2), to: now },
    "12m": { label: "Last 12 months", from: addMonths(now, -11), to: now },
    ytd: { label: "This year", from: `${year}-01`, to: now },
    "last-year": { label: "Last year", from: `${Number(year) - 1}-01`, to: `${Number(year) - 1}-12` },
  } as const;
}
type Preset = keyof ReturnType<typeof presets>;

function Segmented<T extends string>(props: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={props.label}>
      {props.options.map(([key, label]) => (
        <button key={key} className={props.value === key ? "active" : undefined} onClick={() => props.onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Tile(props: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
  hero?: boolean;
  detail?: string;
}) {
  return (
    <div className={props.hero ? "stat-tile hero" : "stat-tile"}>
      <span className="muted">{props.label}</span>
      <strong className={props.tone}>{props.value}</strong>
      {props.detail && <span className="muted small">{props.detail}</span>}
    </div>
  );
}

function NetWorthReport() {
  const [range, setRange] = useState<"1y" | "5y" | "all">("1y");
  const q = useQuery({
    queryKey: ["reports", "net-worth", range],
    queryFn: () => api.get<NetWorthPoint[]>(`/reports/net-worth?range=${range}`),
    placeholderData: keepPreviousData,
  });
  const points = q.data ?? [];
  const last = points.at(-1);
  const change = last && points[0] ? last.netWorth - points[0].netWorth : 0;
  return (
    <>
      {q.error && <p className="error-text">{q.error.message}</p>}
      {last && (
        <div className="kpi-row">
          <Tile hero label="Net worth" value={formatCents(last.netWorth)} />
          <Tile
            label="Change over the period"
            value={`${change >= 0 ? "+" : ""}${formatCents(change)}`}
            tone={change >= 0 ? "positive" : "negative"}
          />
          <Tile label="Assets" value={formatCents(last.assets)} />
          <Tile label="Liabilities" value={formatCents(last.liabilities)} />
        </div>
      )}
      <section className="card wide">
        <div className="card-head">
          <h2>Net worth</h2>
          <Segmented
            label="Time range"
            value={range}
            onChange={setRange}
            options={[
              ["1y", "1Y"],
              ["5y", "5Y"],
              ["all", "All"],
            ]}
          />
        </div>
        {points.length > 1 ? (
          <NetWorthChart points={points} fineDates={range === "1y"} />
        ) : (
          <p className="muted">Not enough history yet. Add some accounts and transactions.</p>
        )}
        <p className="muted small">
          Every account, including investments at market value. Cards and loans count against it.
        </p>
      </section>
    </>
  );
}

function useMonthRange() {
  const [preset, setPreset] = useState<Preset>("12m");
  const now = thisMonth();
  const all = presets(now);
  return {
    preset,
    setPreset,
    ...all[preset],
    options: Object.entries(all).map(([k, v]) => [k, v.label]) as [Preset, string][],
  };
}

function RangePicker(props: { value: Preset; options: [Preset, string][]; onChange: (p: Preset) => void }) {
  return (
    <select aria-label="Period" value={props.value} onChange={(e) => props.onChange(e.target.value as Preset)}>
      {props.options.map(([k, label]) => (
        <option key={k} value={k}>
          {label}
        </option>
      ))}
    </select>
  );
}

function CashFlowReport() {
  const r = useMonthRange();
  const q = useQuery({
    queryKey: ["reports", "cash-flow", r.from, r.to],
    queryFn: () => api.get<CashFlowMonth[]>(`/reports/cash-flow?from=${r.from}&to=${r.to}`),
    placeholderData: keepPreviousData,
  });
  const months = q.data ?? [];
  const income = months.reduce((s, m) => s + m.income, 0);
  const expenses = months.reduce((s, m) => s + m.expenses, 0);
  const net = income - expenses;
  return (
    <>
      {q.error && <p className="error-text">{q.error.message}</p>}
      <div className="kpi-row">
        <Tile
          hero
          label="Saved"
          value={formatCents(net)}
          tone={net >= 0 ? "positive" : "negative"}
          detail={income ? `${((net / income) * 100).toFixed(0)}% of income` : undefined}
        />
        <Tile label="Income" value={formatCents(income)} />
        <Tile label="Spending" value={formatCents(expenses)} />
      </div>
      <section className="card wide">
        <div className="card-head">
          <h2>Income and spending</h2>
          <RangePicker value={r.preset} options={r.options} onChange={r.setPreset} />
        </div>
        {months.length > 0 && <CashFlowChart months={months} />}
        <p className="muted small">
          By category, from accounts included in the budget. Transfers between your accounts aren’t counted here. Your budget can include transfers to off-budget accounts, so its spending total may differ from this report.
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="amount">Income</th>
                <th className="amount">Spending</th>
                <th className="amount">Net</th>
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => (
                <tr key={m.month}>
                  <td>{formatMonth(m.month)}</td>
                  <td className="amount">{formatCents(m.income)}</td>
                  <td className="amount">{formatCents(m.expenses)}</td>
                  <td className={m.net >= 0 ? "amount positive" : "amount negative"}>{formatCents(m.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function SpendingReport() {
  const r = useMonthRange();
  const q = useQuery({
    queryKey: ["reports", "spending", r.from, r.to],
    queryFn: () => api.get<SpendingRow[]>(`/reports/spending?from=${r.from}&to=${r.to}`),
    placeholderData: keepPreviousData,
  });
  const rows = q.data ?? [];
  const total = rows.reduce((s, x) => s + x.amount, 0);
  const months =
    (Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 + Number(r.to.slice(5)) - Number(r.from.slice(5)) + 1;
  return (
    <>
      {q.error && <p className="error-text">{q.error.message}</p>}
      <div className="kpi-row">
        <Tile hero label="Total spending" value={formatCents(total)} />
        {months > 1 && <Tile label="Per month, on average" value={formatCents(Math.round(total / months))} />}
      </div>
      <section className="card wide">
        <div className="card-head">
          <h2>Spending by category</h2>
          <RangePicker value={r.preset} options={r.options} onChange={r.setPreset} />
        </div>
        <SpendingBars rows={rows} />
      </section>
    </>
  );
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get("tab"))?.[0] ?? "net-worth") as Tab;
  return (
    <>
      <header className="page-header budget-header">
        <h1>Reports</h1>
        <Segmented
          label="Report"
          value={tab}
          options={TABS}
          onChange={(t) => setParams(t === "net-worth" ? {} : { tab: t })}
        />
      </header>
      <div className="page-body investments">
        {tab === "net-worth" && <NetWorthReport />}
        {tab === "cash-flow" && <CashFlowReport />}
        {tab === "spending" && <SpendingReport />}
      </div>
    </>
  );
}
