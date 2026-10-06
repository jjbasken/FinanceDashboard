import { formatCents, formatMonth, type CashFlowMonth, type NetWorthPoint, type SpendingRow } from "@fd/shared";
import { useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDate } from "../ledger";
import { compact, SERIES } from "./InvestmentCharts";

const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

const axisProps = {
  stroke: "var(--viz-axis)",
  tick: { fill: "var(--viz-muted)", fontSize: 12 },
  tickLine: false,
} as const;

function NetWorthTooltip(props: { active?: boolean; payload?: { payload: NetWorthPoint }[] }) {
  const p = props.payload?.[0]?.payload;
  if (!props.active || !p) return null;
  return (
    <div className="viz-tooltip">
      <div className="viz-tooltip-title">{formatDate(p.date)}</div>
      <div className="viz-tooltip-row">
        <span className="swatch" style={{ background: SERIES[0] }} />
        <span>Net worth</span>
        <strong>{formatCents(p.netWorth)}</strong>
      </div>
      <div className="viz-tooltip-row">
        <span />
        <span>Assets</span>
        <strong>{formatCents(p.assets)}</strong>
      </div>
      <div className="viz-tooltip-row">
        <span />
        <span>Liabilities</span>
        <strong>{formatCents(p.liabilities)}</strong>
      </div>
    </div>
  );
}

/** Net worth over time: one series, so the title names it and no legend is needed. */
export function NetWorthChart(props: { points: NetWorthPoint[]; fineDates: boolean }) {
  const data = props.points.map((p) => ({ ...p, netD: p.netWorth / 100 }));
  const label = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      ...(props.fineDates ? { day: "numeric" } : { year: "2-digit" }),
      timeZone: "UTC",
    });
  return (
    <div className="viz-plot">
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey="date" tickFormatter={label} minTickGap={40} {...axisProps} />
          <YAxis tickFormatter={(v: number) => compact.format(v)} axisLine={false} width={64} {...axisProps} />
          <ReferenceLine y={0} stroke="var(--viz-axis)" />
          <Tooltip content={<NetWorthTooltip />} cursor={{ stroke: "var(--viz-axis)" }} isAnimationActive={false} />
          <Area
            type="monotone"
            dataKey="netD"
            stroke={SERIES[0]}
            strokeWidth={2}
            fill={SERIES[0]}
            fillOpacity={0.1}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function CashFlowTooltip(props: { active?: boolean; payload?: { payload: CashFlowMonth }[] }) {
  const p = props.payload?.[0]?.payload;
  if (!props.active || !p) return null;
  return (
    <div className="viz-tooltip">
      <div className="viz-tooltip-title">{formatMonth(p.month)}</div>
      <div className="viz-tooltip-row">
        <span className="swatch" style={{ background: SERIES[0] }} />
        <span>Income</span>
        <strong>{formatCents(p.income)}</strong>
      </div>
      <div className="viz-tooltip-row">
        <span className="swatch" style={{ background: SERIES[1] }} />
        <span>Spending</span>
        <strong>{formatCents(p.expenses)}</strong>
      </div>
      <div className="viz-tooltip-row">
        <span />
        <span>Net</span>
        <strong>{formatCents(p.net)}</strong>
      </div>
    </div>
  );
}

/** Income against spending per month: two series, with a legend above the plot. */
export function CashFlowChart(props: { months: CashFlowMonth[] }) {
  const data = props.months.map((m) => ({ ...m, incomeD: m.income / 100, expensesD: m.expenses / 100 }));
  return (
    <figure className="viz">
      <div className="viz-legend" aria-hidden>
        <span>
          <span className="swatch" style={{ background: SERIES[0] }} /> Income
        </span>
        <span>
          <span className="swatch" style={{ background: SERIES[1] }} /> Spending
        </span>
      </div>
      <div className="viz-plot">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis dataKey="month" tickFormatter={monthLabel} {...axisProps} />
            <YAxis tickFormatter={(v: number) => compact.format(v)} axisLine={false} width={64} {...axisProps} />
            <Tooltip
              content={<CashFlowTooltip />}
              cursor={{ fill: "var(--viz-grid)", opacity: 0.5 }}
              isAnimationActive={false}
            />
            <Bar dataKey="incomeD" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            <Bar dataKey="expensesD" fill={SERIES[1]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Spending per category, sorted, as horizontal bars in one hue with direct value labels. */
export function SpendingBars(props: { rows: SpendingRow[]; limit?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const limit = props.limit ?? 15;
  const top = props.rows.slice(0, limit);
  const rest = props.rows.slice(limit);
  const rows = rest.length
    ? [
        ...top,
        {
          categoryId: -1,
          name: `${rest.length} more categories`,
          groupName: "",
          amount: rest.reduce((s, r) => s + r.amount, 0),
        },
      ]
    : top;
  const max = Math.max(...rows.map((r) => r.amount), 1);
  const total = props.rows.reduce((s, r) => s + r.amount, 0);
  if (rows.length === 0) return <p className="muted">No spending in this period.</p>;
  return (
    <ul className="spending-bars">
      {rows.map((r) => {
        const key = `${r.categoryId}-${r.name}`;
        return (
          <li
            key={key}
            className={hover === key ? "active" : undefined}
            onMouseEnter={() => setHover(key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="spending-name truncate" title={r.groupName ? `${r.groupName}: ${r.name}` : r.name}>
              {r.name}
              {r.groupName && <span className="muted"> · {r.groupName}</span>}
            </span>
            <span className="spending-track">
              <span
                className="spending-bar"
                style={{
                  width: `${Math.max(0, (r.amount / max) * 100)}%`,
                  background: r.categoryId === -1 ? "var(--viz-neutral)" : SERIES[0],
                }}
              />
            </span>
            <span className="spending-value">
              {formatCents(r.amount)}
              <span className="muted small"> {total ? `${((r.amount / total) * 100).toFixed(0)}%` : ""}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
