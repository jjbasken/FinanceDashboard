import { formatCents, formatMonth } from "@fd/shared";
import { Link } from "react-router";
import { useState } from "react";
import { thisMonth, useBudget } from "../ledger";
import { useAuthStatus } from "../auth";
import { usePreferences } from "../preferences";
import { QuickEntry } from "../components/QuickEntry";
import { UpcomingBills } from "../components/UpcomingBills";
export function HomePage() {
  const { data: auth } = useAuthStatus(); const budget = useBudget(thisMonth());
  const { preferences } = usePreferences(); const [adding, setAdding] = useState(false);
  const categories = budget.data?.groups.filter(g => !g.isIncome && !g.hidden).flatMap(g => g.categories.filter(c => !c.hidden && !c.excludeFromBudget)) ?? [];
  const favorites = categories.filter(c => preferences.favorites.includes(c.id));
  const over = categories.filter(c => c.balance < 0);
  return <>
    <header className="page-header home-header"><div><p className="eyebrow">{formatMonth(thisMonth())}</p><h1>Hello, {auth?.user?.displayName}</h1><p className="muted">Your family’s plan at a glance.</p></div><button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add purchase</button></header>
    <div className="page-body home-body">
      {budget.error && <p className="error-text" role="alert">Couldn’t load your budget. <button className="btn" onClick={() => budget.refetch()}>Try again</button></p>}
      {budget.isPending && <p role="status">Loading your monthly plan…</p>}
      {budget.data && <section className="home-summary card"><div><span className="muted">{budget.data.toBudget < 0 ? "Assigned over income" : "Left to assign"}</span><strong>{formatCents(Math.abs(budget.data.toBudget))}</strong><small>Income available for this month’s plan, less amounts assigned.</small></div><div><Link to="/review">{budget.data.uncategorized} transaction{budget.data.uncategorized !== 1 ? "s need" : " needs"} a category →</Link><Link to="/budget">{over.length ? `${over.length} categories over plan` : "Open your monthly budget"} →</Link></div></section>}
      <section><div className="card-head"><h2>Your favorite categories</h2><Link to="/settings#preferences">Choose favorites</Link></div>
        {favorites.length ? <div className="favorite-grid">{favorites.map(c => <Link key={c.id} className="card favorite-card" to={`/budget?category=${c.id}`}><span>{c.name}</span><strong className={c.balance < 0 ? "negative" : ""}>{c.balance < 0 ? `Over by ${formatCents(-c.balance)}` : `${formatCents(c.balance)} remaining`}</strong><small className="muted">Planned {formatCents(c.budgeted)} · Spent {formatCents(-c.activity)}</small></Link>)}</div>
        : <div className="card"><p>Choose the categories you check most often, such as Groceries and Dining Out.</p><Link className="btn" to="/settings#preferences">Choose favorites</Link></div>}
      </section>
      {over.length > 0 && <section className="card"><h2>Categories over plan</h2><ul className="simple-list">{over.map(c => <li key={c.id}><Link to={`/budget?category=${c.id}`}>{c.name}</Link><strong className="negative">Over by {formatCents(-c.balance)}</strong></li>)}</ul></section>}
      <UpcomingBills limit={5} />
      <section className="card budget-help"><h2>How this monthly plan works</h2><p>Each month starts fresh. Unspent amounts, overspending, and unassigned income do not carry into the next month. A savings category is a plan for this month, not an accumulating savings balance.</p><p>Scheduled transactions are included in the plan. Purchases without a category are not included in category totals yet. Category amounts are not a bank balance or a guarantee of money available to spend.</p><Link to="/budget">Open budget →</Link></section>
    </div>{adding && <QuickEntry onClose={() => setAdding(false)} />}
  </>;
}
