import { formatCents, type ValuePoint } from "@fd/shared";
import { useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate } from "../ledger";

/** Categorical slots in fixed order (validated against this app's light and dark surfaces). */
export const SERIES = [1, 2, 3, 4, 5, 6, 7].map((n) => `var(--series-${n})`);
export const NEUTRAL = "var(--viz-neutral)";
export const NEUTRAL_LIGHT = "var(--viz-neutral-light)";

const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact" });
/** Axis labels: day and month for short ranges (weekly or daily points), month and year beyond. */
const axisDate = (date: string, fine: boolean) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    ...(fine ? { day: "numeric" } : { year: "2-digit" }),
    timeZone: "UTC",
  });

function ValueTooltip(props: { active?: boolean; payload?: { payload: ValuePoint }[] }) {
  const p = props.payload?.[0]?.payload;
  if (!props.active || !p) return null;
  const gain = p.value - p.invested;
  return (
    <div className="viz-tooltip">
      <div className="viz-tooltip-title">{formatDate(p.date)}</div>
      <div className="viz-tooltip-row">
        <span className="swatch" style={{ background: SERIES[0] }} />
        <span>Value</span>
        <strong>{formatCents(p.value)}</strong>
      </div>
      <div className="viz-tooltip-row">
        <span className="swatch dashed" />
        <span>Invested</span>
        <strong>{formatCents(p.invested)}</strong>
      </div>
      <div className="viz-tooltip-row">
        <span />
        <span>Gain</span>
        <strong>{formatCents(gain)}</strong>
      </div>
    </div>
  );
}

/** Value over time (the point) against money invested (context, in gray). */
export function ValueChart(props: { points: ValuePoint[]; fineDates: boolean }) {
  const data = props.points.map((p) => ({ ...p, valueD: p.value / 100, investedD: p.invested / 100 }));
  return (
    <figure className="viz">
      <div className="viz-legend" aria-hidden>
        <span>
          <span className="swatch" style={{ background: SERIES[0] }} /> Value
        </span>
        <span>
          <span className="swatch dashed" /> Invested
        </span>
      </div>
      <div className="viz-plot">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" strokeWidth={1} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => axisDate(d, props.fineDates)}
              stroke="var(--viz-axis)"
              tick={{ fill: "var(--viz-muted)", fontSize: 12 }}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => compact.format(v)}
              tick={{ fill: "var(--viz-muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={64}
              domain={["auto", "auto"]}
            />
            <Tooltip
              content={<ValueTooltip />}
              cursor={{ stroke: "var(--viz-axis)", strokeWidth: 1 }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="valueD"
              stroke={SERIES[0]}
              strokeWidth={2}
              fill={SERIES[0]}
              fillOpacity={0.1}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="investedD"
              stroke={NEUTRAL}
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export interface Slice {
  key: string;
  label: string;
  sublabel?: string;
  value: number;
  color: string;
}

/** Part-to-whole as one 100% bar, with a legend that carries the labels and numbers. */
export function AllocationBar(props: { slices: Slice[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = props.slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total <= 0) return <p className="muted">Nothing to show yet.</p>;
  const pct = (v: number) => `${((v / total) * 100).toFixed(1)}%`;
  const shown = props.slices.filter((s) => s.value > 0);
  return (
    <figure className="viz">
      <div className="allocation-bar" role="img" aria-label="Allocation by holding">
        {shown.map((s) => (
          <div
            key={s.key}
            className={hover && hover !== s.key ? "allocation-segment dim" : "allocation-segment"}
            style={{ flexGrow: s.value, background: s.color }}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            {hover === s.key && (
              <div className="viz-tooltip allocation-tooltip">
                <div className="viz-tooltip-title">{s.label}</div>
                <div>
                  {formatCents(s.value)} · {pct(s.value)}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <ul className="allocation-legend">
        {shown.map((s) => (
          <li
            key={s.key}
            className={hover === s.key ? "active" : undefined}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="swatch" style={{ background: s.color }} />
            <span className="truncate">
              <strong>{s.label}</strong>
              {s.sublabel && <span className="muted"> {s.sublabel}</span>}
            </span>
            <span className="muted">{pct(s.value)}</span>
            <span>{formatCents(s.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
