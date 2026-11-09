import {
  addMonths,
  formatCents,
  formatMonth,
  type BudgetVsActualMonth,
  type CashFlowMonth,
  type CategoryBreakdown,
  type CategoryComparison,
  type CategoryTotal,
  type NetWorthPoint,
  type YearComparison,
} from "@fd/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import {
  BudgetVsActualChart,
  CashFlowChart,
  CategoryBars,
  NetWorthChart,
  YearCompareChart,
} from "../components/ReportCharts";
import { SERIES } from "../components/InvestmentCharts";
import { thisMonth } from "../ledger";

type Tab = "net-worth" | "over-time" | "breakdown" | "compare" | "budget";
const TABS: [Tab, string][] = [
  ["net-worth", "Net worth"],
  ["over-time", "Over time"],
  ["breakdown", "Breakdown"],
  ["compare", "Compare"],
  ["budget", "Budget"],
];
/** Older links to tabs that were renamed. */
const TAB_ALIASES: Record<string, Tab> = { "cash-flow": "over-time", spending: "breakdown" };

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Month ranges, inclusive, relative to the current month. */
function presets(now: string) {
  const year = now.slice(0, 4);
  return {
    "this-month": { label: "This month", from: now, to: now },
    "last-month": { label: "Last month", from: addMonths(now, -1), to: addMonths(now, -1) },
    "3m": { label: "Last 3 months", from: addMonths(now, -2), to: now },
    "12m": { label: "Last 12 months", from: addMonths(now, -11), to: now },
    "24m": { label: "Last 2 years", from: addMonths(now, -23), to: now },
    "60m": { label: "Last 5 years", from: addMonths(now, -59), to: now },
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
  const active = useRef<HTMLButtonElement>(null);
  // On a narrow screen the buttons can scroll sideways; keep the chosen one in view.
  useEffect(() => {
    const button = active.current;
    const strip = button?.parentElement;
    if (!button || !strip || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = button.offsetLeft - (strip.clientWidth - button.offsetWidth) / 2;
  }, [props.value]);
  return (
    <div className="segmented" role="group" aria-label={props.label}>
      {props.options.map(([key, label]) => (
        <button
          key={key}
          ref={props.value === key ? active : undefined}
          className={props.value === key ? "active" : undefined}
          aria-pressed={props.value === key}
          onClick={() => props.onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

type Tone = "positive" | "negative";

function Tile(props: {
  label: string;
  value: string;
  tone?: Tone;
  hero?: boolean;
  detail?: string;
  detailTone?: Tone;
}) {
  return (
    <div className={props.hero ? "stat-tile hero" : "stat-tile"}>
      <span className="muted">{props.label}</span>
      <strong className={props.tone}>{props.value}</strong>
      {props.detail && <span className={props.detailTone ? `small ${props.detailTone}` : "muted small"}>{props.detail}</span>}
    </div>
  );
}

const sum = <T,>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0);
const signed = (cents: number) => `${cents > 0 ? "+" : ""}${formatCents(cents)}`;
const percent = (part: number, whole: number) => `${((part / whole) * 100).toFixed(0)}%`;
const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5)) + 1;

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

function useMonthRange(initial: Preset) {
  const [preset, setPreset] = useState<Preset>(initial);
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

/** Monthly rows summed into one row per calendar year, noting how many months each covers. */
function byYear(months: CashFlowMonth[]) {
  const years = new Map<string, CashFlowMonth & { months: number }>();
  for (const m of months) {
    const key = m.month.slice(0, 4);
    const y = years.get(key) ?? { month: key, income: 0, expenses: 0, net: 0, months: 0 };
    y.income += m.income;
    y.expenses += m.expenses;
    y.net += m.net;
    y.months += 1;
    years.set(key, y);
  }
  return [...years.values()];
}

function OverTimeReport() {
  const r = useMonthRange("12m");
  const [step, setStep] = useState<"month" | "year">("month");
  const q = useQuery({
    queryKey: ["reports", "cash-flow", r.from, r.to],
    queryFn: () => api.get<CashFlowMonth[]>(`/reports/cash-flow?from=${r.from}&to=${r.to}`),
    placeholderData: keepPreviousData,
  });
  const months = q.data ?? [];
  const income = sum(months, (m) => m.income);
  const expenses = sum(months, (m) => m.expenses);
  const net = income - expenses;
  const count = months.length;
  const years = byYear(months);
  const yearTitle = (y: string) => {
    const covered = years.find((x) => x.month === y)?.months ?? 12;
    return covered < 12 ? `${y} (${covered} ${covered === 1 ? "month" : "months"})` : y;
  };
  const rows = step === "year" ? years : months;
  return (
    <>
      {q.error && <p className="error-text">{q.error.message}</p>}
      <div className="kpi-row">
        <Tile
          hero
          label="Saved"
          value={formatCents(net)}
          tone={net >= 0 ? "positive" : "negative"}
          detail={income ? `${percent(net, income)} of income` : undefined}
        />
        <Tile
          label="Income"
          value={formatCents(income)}
          detail={count > 1 ? `${formatCents(Math.round(income / count))} a month` : undefined}
        />
        <Tile
          label="Spending"
          value={formatCents(expenses)}
          detail={count > 1 ? `${formatCents(Math.round(expenses / count))} a month` : undefined}
        />
      </div>
      <section className="card wide">
        <div className="card-head wrap">
          <h2>Income and spending</h2>
          <div className="card-controls">
            <Segmented
              label="Group by"
              value={step}
              onChange={setStep}
              options={[
                ["month", "Monthly"],
                ["year", "Yearly"],
              ]}
            />
            <RangePicker value={r.preset} options={r.options} onChange={r.setPreset} />
          </div>
        </div>
        {rows.length > 0 &&
          (step === "year" ? (
            <CashFlowChart months={years} label={(y) => y} title={yearTitle} />
          ) : (
            <CashFlowChart months={months} />
          ))}
        <p className="muted small">
          By category, from accounts included in the budget. Transfers between your accounts aren’t counted here. Your budget can include transfers to off-budget accounts, so its spending total may differ from this report.
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>{step === "year" ? "Year" : "Month"}</th>
                <th className="amount">Income</th>
                <th className="amount">Spending</th>
                <th className="amount">Net</th>
                <th className="amount">Saved</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((m) => (
                <tr key={m.month}>
                  <td>{step === "year" ? yearTitle(m.month) : formatMonth(m.month)}</td>
                  <td className="amount">{formatCents(m.income)}</td>
                  <td className="amount">{formatCents(m.expenses)}</td>
                  <td className={m.net >= 0 ? "amount positive" : "amount negative"}>{formatCents(m.net)}</td>
                  <td className="amount muted">{m.income > 0 ? percent(m.net, m.income) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** Rows grouped by category group, groups largest first, each with its subtotal. */
function grouped(rows: CategoryTotal[]) {
  const groups = new Map<number | null, CategoryTotal[]>();
  for (const r of rows) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r]);
  return [...groups.entries()]
    .map(([id, list]) => ({
      id,
      name: list[0]!.groupName || "Uncategorized",
      rows: list,
      total: sum(list, (x) => x.amount),
    }))
    .sort((a, b) => b.total - a.total);
}

function StatementSection(props: { title: string; rows: CategoryTotal[]; total: number }) {
  return (
    <>
      <tr className="section-row">
        <td>{props.title}</td>
        <td className="amount">{formatCents(props.total)}</td>
        <td className="amount muted" />
      </tr>
      {grouped(props.rows).map((g) => (
        <StatementGroup key={g.id ?? "none"} group={g} total={props.total} />
      ))}
    </>
  );
}

function StatementGroup(props: { group: ReturnType<typeof grouped>[number]; total: number }) {
  const { group } = props;
  const single = group.rows.length === 1 && group.rows[0]!.name === group.name;
  return (
    <>
      <tr className="group-row">
        <td>{group.name}</td>
        <td className="amount">{formatCents(group.total)}</td>
        <td className="amount muted">{props.total ? percent(group.total, props.total) : ""}</td>
      </tr>
      {!single &&
        group.rows.map((r) => (
          <tr key={`${r.categoryId}`}>
            <td className="indent">{r.name}</td>
            <td className="amount">{formatCents(r.amount)}</td>
            <td className="amount muted">{props.total ? percent(r.amount, props.total) : ""}</td>
          </tr>
        ))}
    </>
  );
}

function BreakdownReport() {
  const r = useMonthRange("ytd");
  const q = useQuery({
    queryKey: ["reports", "breakdown", r.from, r.to],
    // The period travels with its figures: while a new period loads, the old figures stay up
    // under their own heading rather than the new one's.
    queryFn: async () => ({
      from: r.from,
      to: r.to,
      ...(await api.get<CategoryBreakdown>(`/reports/breakdown?from=${r.from}&to=${r.to}`)),
    }),
    placeholderData: keepPreviousData,
  });
  const income = q.data?.income ?? [];
  const expenses = q.data?.expenses ?? [];
  const totalIncome = sum(income, (x) => x.amount);
  const totalSpending = sum(expenses, (x) => x.amount);
  const net = totalIncome - totalSpending;
  const from = q.data?.from ?? r.from;
  const to = q.data?.to ?? r.to;
  const months = monthsBetween(from, to);
  return (
    <>
      {q.error && <p className="error-text">{q.error.message}</p>}
      <div className="card-head wrap">
        <p className="muted" aria-live="polite">
          {from === to ? formatMonth(from) : `${formatMonth(from)} – ${formatMonth(to)}`}
          {q.isPlaceholderData && " · loading…"}
        </p>
        <RangePicker value={r.preset} options={r.options} onChange={r.setPreset} />
      </div>
      <div className="kpi-row">
        <Tile
          hero
          label="Net"
          value={formatCents(net)}
          tone={net >= 0 ? "positive" : "negative"}
          detail={totalIncome ? `${percent(net, totalIncome)} of income saved` : undefined}
        />
        <Tile
          label="Income"
          value={formatCents(totalIncome)}
          detail={months > 1 ? `${formatCents(Math.round(totalIncome / months))} a month` : undefined}
        />
        <Tile
          label="Spending"
          value={formatCents(totalSpending)}
          detail={months > 1 ? `${formatCents(Math.round(totalSpending / months))} a month` : undefined}
        />
      </div>
      <div className="report-pair">
        <section className="card wide">
          <h2>Income by category</h2>
          <CategoryBars rows={income} color={SERIES[0]} emptyText="No income in this period." />
        </section>
        <section className="card wide">
          <h2>Spending by category</h2>
          <CategoryBars rows={expenses} color={SERIES[1]} emptyText="No spending in this period." />
        </section>
      </div>
      <section className="card wide">
        <h2>Income statement</h2>
        <div className="table-scroll">
          <table className="data-table statement">
            <thead>
              <tr>
                <th>Category</th>
                <th className="amount">Amount</th>
                <th className="amount">Share</th>
              </tr>
            </thead>
            <tbody>
              <StatementSection title="Income" rows={income} total={totalIncome} />
              <StatementSection title="Spending" rows={expenses} total={totalSpending} />
              <tr className="section-row total-row">
                <td>Net</td>
                <td className={net >= 0 ? "amount positive" : "amount negative"}>{formatCents(net)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted small">
          From accounts included in the budget, without transfers between your accounts or opening balances. Uncategorized spending is shown as its own row.
        </p>
      </section>
    </>
  );
}

/** "+12%", or a word when there's nothing to compare with. */
function changePercent(current: number, previous: number) {
  if (previous === 0) return current === 0 ? "—" : "new";
  const p = ((current - previous) / Math.abs(previous)) * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(0)}%`;
}

/** Tone for a change: more income or saving is good, more spending isn't. */
function changeTone(change: number, moreIsGood: boolean): Tone | undefined {
  if (change === 0) return undefined;
  return change > 0 === moreIsGood ? "positive" : "negative";
}

function CompareTable(props: {
  title: string;
  rows: CategoryComparison[];
  moreIsGood: boolean;
  sort: "amount" | "change";
}) {
  const rows = [...props.rows].sort((a, b) =>
    props.sort === "change"
      ? Math.abs(b.current - b.previous) - Math.abs(a.current - a.previous)
      : b.current - a.current || b.previous - a.previous,
  );
  const current = sum(rows, (r) => r.current);
  const previous = sum(rows, (r) => r.previous);
  const line = (key: string, name: string, now: number, then: number, cls?: string, group?: string) => (
    <tr key={key} className={cls}>
      <td className="truncate" title={group ? `${group}: ${name}` : name}>
        {name}
        {group && <span className="muted"> · {group}</span>}
      </td>
      <td className="amount">{formatCents(then)}</td>
      <td className="amount">{formatCents(now)}</td>
      <td className={`amount ${changeTone(now - then, props.moreIsGood) ?? ""}`}>{signed(now - then)}</td>
      <td className="amount muted">{changePercent(now, then)}</td>
    </tr>
  );
  return (
    <>
      <tr className="section-row">
        <td colSpan={5}>{props.title}</td>
      </tr>
      {rows.map((r) =>
        line(`${r.categoryId}`, r.name, r.current, r.previous, undefined, r.groupName === r.name ? "" : r.groupName),
      )}
      {line("total", `Total ${props.title.toLowerCase()}`, current, previous, "group-row")}
    </>
  );
}

function CompareReport() {
  const now = thisMonth();
  const latest = now.slice(5) === "01" ? Number(now.slice(0, 4)) - 1 : Number(now.slice(0, 4));
  const [year, setYear] = useState(latest);
  const [metric, setMetric] = useState<"expenses" | "income">("expenses");
  const [sort, setSort] = useState<"amount" | "change">("amount");
  const q = useQuery({
    queryKey: ["reports", "compare", year],
    queryFn: () => api.get<YearComparison>(`/reports/compare?year=${year}`),
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  // The same earliest year the server accepts: twenty before the calendar year.
  const earliest = Math.max(data?.firstYear ?? latest, Number(now.slice(0, 4)) - 20);
  const years = Array.from({ length: Math.max(latest - earliest, 0) + 1 }, (_, i) => latest - i);
  const throughMonth = data ? Number(data.through.slice(5)) : 12;
  const span = throughMonth === 12 ? "Full year" : `Jan–${SHORT_MONTHS[throughMonth - 1]}`;
  const prevMatching = data?.previous.slice(0, throughMonth) ?? [];
  const totals = {
    income: [sum(data?.current ?? [], (m) => m.income), sum(prevMatching, (m) => m.income)],
    expenses: [sum(data?.current ?? [], (m) => m.expenses), sum(prevMatching, (m) => m.expenses)],
  } as const;
  const saved = [totals.income[0] - totals.expenses[0], totals.income[1] - totals.expenses[1]] as const;
  const tile = (label: string, [cur, prev]: readonly [number, number], moreIsGood: boolean, hero = false) => (
    <Tile
      hero={hero}
      label={label}
      value={formatCents(cur)}
      tone={hero ? (cur >= 0 ? "positive" : "negative") : undefined}
      detail={`${signed(cur - prev)} (${changePercent(cur, prev)}) vs ${formatCents(prev)}`}
      detailTone={changeTone(cur - prev, moreIsGood)}
    />
  );
  return (
    <>
      {q.error && <p className="error-text">{q.error.message}</p>}
      <div className="card-head wrap">
        <p className="muted">
          {data
            ? throughMonth === 12
              ? `${data.year} compared with ${data.year - 1}`
              : `${span} ${data.year} compared with ${span} ${data.year - 1}`
            : "\u00a0"}
          {data && throughMonth < 12 && " · this month is left out until it’s over"}
        </p>
        <select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y} vs {y - 1}
            </option>
          ))}
        </select>
      </div>
      {data && (
        <>
          <div className="kpi-row">
            {tile("Saved", saved, true, true)}
            {tile("Income", totals.income, true)}
            {tile("Spending", totals.expenses, false)}
          </div>
          <section className="card wide">
            <div className="card-head wrap">
              <h2>{metric === "income" ? "Income" : "Spending"} by month</h2>
              <Segmented
                label="Measure"
                value={metric}
                onChange={setMetric}
                options={[
                  ["expenses", "Spending"],
                  ["income", "Income"],
                ]}
              />
            </div>
            <YearCompareChart year={data.year} current={data.current} previous={data.previous} metric={metric} />
          </section>
          <section className="card wide">
            <div className="card-head wrap">
              <h2>By category</h2>
              <Segmented
                label="Sort"
                value={sort}
                onChange={setSort}
                options={[
                  ["amount", "Largest"],
                  ["change", "Biggest changes"],
                ]}
              />
            </div>
            <div className="table-scroll">
              <table className="data-table statement">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="amount">{data.year - 1}</th>
                    <th className="amount">{data.year}</th>
                    <th className="amount">Change</th>
                    <th className="amount">%</th>
                  </tr>
                </thead>
                <tbody>
                  <CompareTable
                    title="Income"
                    rows={data.categories.filter((c) => c.isIncome)}
                    moreIsGood
                    sort={sort}
                  />
                  <CompareTable
                    title="Spending"
                    rows={data.categories.filter((c) => !c.isIncome)}
                    moreIsGood={false}
                    sort={sort}
                  />
                </tbody>
              </table>
            </div>
            <p className="muted small">
              {throughMonth === 12 ? "Whole years" : `${span} of each year`}, from accounts included in the budget, without transfers or opening balances.
            </p>
          </section>
        </>
      )}
    </>
  );
}

/** "$12.00 under" or "$12.00 over" the budget. */
const underOver = (cents: number) => `${formatCents(Math.abs(cents))} ${cents >= 0 ? "under" : "over"}`;

function BudgetReport() {
  const r = useMonthRange("12m");
  const q = useQuery({
    queryKey: ["reports", "budget", r.from, r.to],
    queryFn: () => api.get<BudgetVsActualMonth[]>(`/reports/budget?from=${r.from}&to=${r.to}`),
    placeholderData: keepPreviousData,
  });
  const months = q.data ?? [];
  const now = thisMonth();
  // A month still under way is mostly unspent, so it would skew the total; it gets its own tile.
  const current = months.length > 1 ? months.find((m) => m.month === now) : undefined;
  const done = months.filter((m) => m !== current);
  const budgeted = done.reduce((s, m) => s + m.budgeted, 0);
  const spent = done.reduce((s, m) => s + m.spent, 0);
  const remaining = budgeted - spent;
  const over = done.filter((m) => m.remaining < 0).length;
  return (
    <>
      {q.error && <p className="error-text">{q.error.message}</p>}
      <div className="kpi-row">
        <Tile
          hero
          label={`${remaining >= 0 ? "Under budget" : "Over budget"}${current ? ", past months" : ""}`}
          value={formatCents(Math.abs(remaining))}
          tone={remaining >= 0 ? "positive" : "negative"}
          detail={budgeted ? `${((spent / budgeted) * 100).toFixed(0)}% of the budget spent` : undefined}
        />
        {current && (
          <Tile
            label={`${current.remaining >= 0 ? "Under budget" : "Over budget"}, this month so far`}
            value={formatCents(Math.abs(current.remaining))}
            tone={current.remaining >= 0 ? "positive" : "negative"}
            detail={`${formatCents(current.spent)} of ${formatCents(current.budgeted)} spent`}
          />
        )}
        <Tile label="Budgeted" value={formatCents(budgeted)} />
        <Tile label="Spent" value={formatCents(spent)} />
        {done.length > 1 && <Tile label="Months over budget" value={`${over} of ${done.length}`} />}
      </div>
      <section className="card wide">
        <div className="card-head">
          <h2>Budget vs. actual</h2>
          <RangePicker value={r.preset} options={r.options} onChange={r.setPreset} />
        </div>
        {months.length > 1 && <BudgetVsActualChart months={months} current={now} />}
        <p className="muted small">
          Expense categories, as on the budget page. Each month stands alone. The month under way is shown faded and left out of the totals above.
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="amount">Budgeted</th>
                <th className="amount">Spent</th>
                <th className="amount">Under / over</th>
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => (
                <tr key={m.month}>
                  <td>
                    {formatMonth(m.month)}
                    {m.month === now && <span className="muted small"> · so far</span>}
                  </td>
                  <td className="amount">{formatCents(m.budgeted)}</td>
                  <td className="amount">{formatCents(m.spent)}</td>
                  <td className={m.remaining >= 0 ? "amount positive" : "amount negative"}>{underOver(m.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") ?? "";
  const tab = (TABS.find(([k]) => k === raw)?.[0] ?? (Object.hasOwn(TAB_ALIASES, raw) ? TAB_ALIASES[raw] : undefined) ?? "net-worth") as Tab;
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
        {tab === "over-time" && <OverTimeReport />}
        {tab === "breakdown" && <BreakdownReport />}
        {tab === "compare" && <CompareReport />}
        {tab === "budget" && <BudgetReport />}
      </div>
    </>
  );
}
