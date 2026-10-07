import {
  addMonths,
  centsToInput,
  formatCents,
  formatMonth,
  monthName,
  monthSchema,
  parseCents,
  type BudgetCategory,
  type BudgetGroup,
  type BudgetMonth,
  type CategoryActivityItem,
  type CategoryGroup,
} from "@fd/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type KeyboardEvent, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { formatDate, ledgerKeys, thisMonth, useBudget, useLedgerMutation } from "../ledger";

type Move = -1 | 0 | 1;

function Money(props: { cents: number; className?: string }) {
  return <span className={props.className}>{formatCents(props.cents)}</span>;
}

function BalancePill(props: { cents: number }) {
  const kind = props.cents > 0 ? "positive" : props.cents < 0 ? "negative" : "zero";
  return <span className={`balance-pill ${kind}`}>{formatCents(props.cents)}</span>;
}

/** The inline editor for a budgeted amount. Enter/Tab/arrows save and move; Esc cancels. */
function BudgetInput(props: { initial: number; onDone: (amount: number | null, move: Move) => void }) {
  const [text, setText] = useState(props.initial ? centsToInput(props.initial) : "");
  const [invalid, setInvalid] = useState(false);
  const done = useRef(false);

  function finish(move: Move, cancel = false) {
    if (done.current) return;
    if (cancel) {
      done.current = true;
      return props.onDone(null, 0);
    }
    const amount = text.trim() === "" ? 0 : parseCents(text);
    if (amount === null) return setInvalid(true);
    done.current = true;
    props.onDone(amount, move);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const moves: Record<string, Move> = { Enter: 1, ArrowDown: 1, ArrowUp: -1 };
    if (e.key === "Tab") {
      e.preventDefault();
      finish(e.shiftKey ? -1 : 1);
    } else if (e.key in moves) {
      e.preventDefault();
      finish(moves[e.key]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(0, true);
    }
  }

  return (
    <input
      className={invalid ? "budget-input invalid" : "budget-input"}
      aria-label="Budgeted"
      inputMode="decimal"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        setInvalid(false);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => finish(0)}
    />
  );
}

function ToBudget(props: { budget: BudgetMonth }) {
  const b = props.budget;
  const over = b.toBudget < 0;
  return (
    <div className={over ? "to-budget over" : b.toBudget === 0 ? "to-budget zero" : "to-budget"}>
      <div className="to-budget-amount">
        <span>{over ? "Overbudgeted" : "To Budget"}</span>
        <strong>{formatCents(b.toBudget)}</strong>
      </div>
      <dl className="to-budget-breakdown">
        {b.incomeFromLastMonth !== 0 && (
          <>
            <dt>Income from {formatMonth(addMonths(b.month, -1))}</dt>
            <dd>{formatCents(b.incomeFromLastMonth)}</dd>
          </>
        )}
        <dt>{b.incomeFromLastMonth !== 0 ? "Other income this month" : "Income this month"}</dt>
        <dd>{formatCents(b.income - b.incomeFromLastMonth)}</dd>
        <dt>Budgeted this month</dt>
        <dd>{formatCents(-b.budgeted)}</dd>
      </dl>
    </div>
  );
}

function ActivityDialog(props: { month: string; category: BudgetCategory; onClose: () => void }) {
  const items = useQuery({
    queryKey: ["budget", props.month, "activity", props.category.id],
    queryFn: () =>
      api.get<CategoryActivityItem[]>(`/budget/${props.month}/categories/${props.category.id}/transactions`),
  });
  return (
    <Dialog
      title={
        props.category.forNextMonth
          ? `${props.category.name}: received in ${formatMonth(addMonths(props.month, -1))}`
          : `${props.category.name}: ${formatMonth(props.month)}`
      }
      submitLabel="Close"
      noCancel
      wide
      onClose={props.onClose}
      onSubmit={props.onClose}
      error={items.error?.message}
    >
      {items.isPending && <p className="muted">Loading…</p>}
      {items.data?.length === 0 && <p className="muted">No transactions in this category this month.</p>}
      {items.data && items.data.length > 0 && (
        <table className="activity-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Account</th>
              <th>Payee</th>
              <th>Notes</th>
              <th className="amount">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.data.map((t) => (
              <tr key={t.id}>
                <td>{formatDate(t.date)}</td>
                <td>
                  <Link to={`/accounts/${t.accountId}`} onClick={props.onClose}>
                    {t.accountName}
                  </Link>
                </td>
                <td>{t.payeeName}</td>
                <td className="muted">{t.notes}</td>
                <td className={t.amount < 0 ? "amount" : "amount positive"}>{formatCents(t.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

type Dragging = { kind: "category"; id: number } | { kind: "group"; id: number; isIncome: boolean };

export function BudgetPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("month");
  const month = requested && monthSchema.safeParse(requested).success ? requested : thisMonth();
  const go = (m: string) => setParams(m === thisMonth() ? {} : { month: m });

  const qc = useQueryClient();
  const budget = useBudget(month);
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [activityFor, setActivityFor] = useState<BudgetCategory | null>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Months are independent, so a change only affects the month it was made in.
  const putBudget = (data: BudgetMonth) => qc.setQueryData(ledgerKeys.budget(data.month), data);

  const setAmount = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) =>
      api.put<BudgetMonth>(`/budget/${month}/categories/${id}`, { amount }),
    onSuccess: putBudget,
  });
  const copyLast = useMutation({
    mutationFn: () => api.post<BudgetMonth>(`/budget/${month}/copy-last-month`),
    onSuccess: putBudget,
  });
  const edit = useLedgerMutation(({ method, path, body }: { method: "post" | "patch"; path: string; body: unknown }) =>
    api[method](path, body),
  );
  const move = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api.post<CategoryGroup[]>(path, body),
    onSuccess: (groups) => {
      qc.setQueryData(ledgerKeys.categories, groups);
      void qc.invalidateQueries({ queryKey: ["budget"] });
    },
  });

  const data = budget.data;
  const visible = (x: { hidden: boolean }) => showHidden || !x.hidden;
  const expenseGroups = (data?.groups ?? [])
    .filter((g) => !g.isIncome && visible(g))
    .map((g) => ({ ...g, categories: g.categories.filter(visible) }));
  const incomeGroups = (data?.groups ?? []).filter((g) => g.isIncome && visible(g));
  const order = expenseGroups.flatMap((g) => g.categories.filter((c) => !c.excludeFromBudget).map((c) => c.id));

  function finishEdit(category: BudgetCategory, amount: number | null, step: Move) {
    if (amount !== null && amount !== category.budgeted) setAmount.mutate({ id: category.id, amount });
    const next = step ? order[order.indexOf(category.id) + step] : undefined;
    setEditing(next ?? null);
  }

  function ask(label: string, initial = "") {
    return prompt(label, initial)?.trim() || null;
  }

  // --- Drag and drop: categories drop before a category or at the end of a group; groups drop before a group.
  const dragProps = (d: Dragging) => ({
    draggable: editing === null,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "");
      setDragging(d);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropTarget(null);
    },
  });

  function dropOnCategory(group: BudgetGroup, category: BudgetCategory) {
    return {
      onDragOver: (e: DragEvent) => {
        if (dragging?.kind !== "category" || dragging.id === category.id) return;
        e.preventDefault();
        setDropTarget(`c${category.id}`);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (dragging?.kind !== "category") return;
        move.mutate({ path: `/categories/${dragging.id}/move`, body: { groupId: group.id, beforeId: category.id } });
        setDropTarget(null);
      },
    };
  }

  function dropOnGroup(group: BudgetGroup) {
    const accepts = (d: Dragging | null) =>
      d && (d.kind === "category" || (d.id !== group.id && d.isIncome === group.isIncome));
    return {
      onDragOver: (e: DragEvent) => {
        if (!accepts(dragging)) return;
        e.preventDefault();
        setDropTarget(`g${group.id}`);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (!accepts(dragging)) return;
        if (dragging!.kind === "category") {
          move.mutate({ path: `/categories/${dragging!.id}/move`, body: { groupId: group.id, beforeId: null } });
        } else {
          move.mutate({ path: `/categories/groups/${dragging!.id}/move`, body: { beforeId: group.id } });
        }
        setDropTarget(null);
      },
    };
  }

  const dropClass = (key: string) => (dropTarget === key ? " drop-target" : "");
  const groupDropHint = dragging?.kind === "category" ? "drop-append" : "drop-before";

  function groupActions(g: BudgetGroup) {
    return (
      <span className="row-actions-inline">
        <button
          className="link-button"
          onClick={() => {
            const name = ask(`New category in ${g.name}`);
            if (name) edit.mutate({ method: "post", path: "/categories", body: { groupId: g.id, name } });
          }}
        >
          Add category
        </button>
        <button
          className="link-button"
          onClick={() => {
            const name = ask("Rename group", g.name);
            if (name) edit.mutate({ method: "patch", path: `/categories/groups/${g.id}`, body: { name } });
          }}
        >
          Rename
        </button>
        <button
          className="link-button"
          onClick={() =>
            edit.mutate({ method: "patch", path: `/categories/groups/${g.id}`, body: { hidden: !g.hidden } })
          }
        >
          {g.hidden ? "Show" : "Hide"}
        </button>
      </span>
    );
  }

  function categoryActions(c: BudgetCategory, isIncome = false) {
    return (
      <span className="row-actions-inline">
        {isIncome && !c.excludeFromBudget && (
          <button
            className="link-button"
            title={
              c.forNextMonth
                ? "Budget this income in the month it arrives"
                : "Budget this income in the month after it arrives, e.g. pay that lands at the end of the month"
            }
            onClick={() =>
              edit.mutate({ method: "patch", path: `/categories/${c.id}`, body: { forNextMonth: !c.forNextMonth } })
            }
          >
            {c.forNextMonth ? "Use when received" : "Use next month"}
          </button>
        )}
        <button
          className="link-button"
          onClick={() => {
            const name = ask("Rename category", c.name);
            if (name) edit.mutate({ method: "patch", path: `/categories/${c.id}`, body: { name } });
          }}
        >
          Rename
        </button>
        <button
          className="link-button"
          onClick={() => edit.mutate({ method: "patch", path: `/categories/${c.id}`, body: { hidden: !c.hidden } })}
        >
          {c.hidden ? "Show" : "Hide"}
        </button>
        <button
          className="link-button"
          title={
            c.excludeFromBudget
              ? "Count this category in the budget and reports again"
              : "Keep this category out of the budget and reports, e.g. reimbursable work expenses"
          }
          onClick={() =>
            edit.mutate({
              method: "patch",
              path: `/categories/${c.id}`,
              body: { excludeFromBudget: !c.excludeFromBudget },
            })
          }
        >
          {c.excludeFromBudget ? "Include in budget" : "Exclude from budget"}
        </button>
      </span>
    );
  }

  const excludedBadge = (
    <span className="badge" title="Shown for reference; not counted in the budget or reports">
      Not in budget
    </span>
  );

  const shownBudgeted = (c: BudgetCategory) =>
    setAmount.isPending && setAmount.variables.id === c.id ? setAmount.variables.amount : c.budgeted;

  const mutationError = setAmount.error ?? copyLast.error ?? edit.error ?? move.error;

  return (
    <>
      <header className="page-header budget-header">
        <div className="month-nav">
          <button className="btn" aria-label="Previous month" onClick={() => go(addMonths(month, -1))}>
            ‹
          </button>
          <h1>{formatMonth(month)}</h1>
          <button className="btn" aria-label="Next month" onClick={() => go(addMonths(month, 1))}>
            ›
          </button>
          {month !== thisMonth() && (
            <button className="btn btn-small" onClick={() => go(thisMonth())}>
              This month
            </button>
          )}
        </div>
        {data && <ToBudget budget={data} />}
      </header>

      <div className="account-toolbar">
        <label className="checkbox inline">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          <span>Show hidden</span>
        </label>
        <span className="spacer" />
        <button
          className="btn"
          disabled={copyLast.isPending}
          onClick={() => {
            if (data?.budgeted && !confirm(`Replace this month's budget with ${formatMonth(addMonths(month, -1))}'s?`))
              return;
            copyLast.mutate();
          }}
        >
          Copy last month
        </button>
        <button
          className="btn"
          onClick={() => {
            const name = ask("New category group name");
            if (name) edit.mutate({ method: "post", path: "/categories/groups", body: { name } });
          }}
        >
          Add group
        </button>
      </div>

      {(budget.error ?? mutationError) && (
        <p className="error-text page-error">{(budget.error ?? mutationError)!.message}</p>
      )}
      {data && data.uncategorized > 0 && (
        <p className="notice">
          {data.uncategorized} transaction{data.uncategorized === 1 ? "" : "s"} this month{" "}
          {data.uncategorized === 1 ? "needs" : "need"} a category. Search an account's register for “uncategorized” to
          find {data.uncategorized === 1 ? "it" : "them"}.
        </p>
      )}

      {!data && !budget.error && <p className="muted page-error">Loading…</p>}
      {data && (
        <div
          className={budget.isPlaceholderData ? "budget-grid stale" : "budget-grid"}
          onDragLeave={() => setDropTarget(null)}
        >
          <div className="budget-row budget-head">
            <div>Category</div>
            <div className="amount">Budgeted</div>
            <div className="amount">Spent</div>
            <div className="amount">Balance</div>
          </div>
          <div className="budget-row budget-total">
            <div>Total</div>
            <Money className="amount" cents={data.budgeted} />
            <Money className="amount" cents={data.spent} />
            <Money
              className="amount"
              cents={data.groups.filter((g) => !g.isIncome).reduce((s, g) => s + g.balance, 0)}
            />
          </div>

          {expenseGroups.map((g) => (
            <div key={g.id} className={g.hidden ? "budget-group hidden" : "budget-group"}>
              <div
                className={`budget-row group-row ${groupDropHint}${dropClass(`g${g.id}`)}`}
                {...dragProps({ kind: "group", id: g.id, isIncome: false })}
                {...dropOnGroup(g)}
              >
                <div className="name">
                  <span className="drag-handle" aria-hidden>
                    ⋮⋮
                  </span>
                  <span className="truncate">{g.name}</span>
                  {groupActions(g)}
                </div>
                <Money className="amount" cents={g.budgeted} />
                <Money className="amount" cents={g.activity} />
                <Money className="amount" cents={g.balance} />
              </div>
              {g.categories.map((c) => (
                <div
                  key={c.id}
                  className={`budget-row category-line${c.hidden ? " hidden" : ""}${c.excludeFromBudget ? " excluded" : ""} drop-before${dropClass(`c${c.id}`)}`}
                  {...dragProps({ kind: "category", id: c.id })}
                  {...dropOnCategory(g, c)}
                >
                  <div className="name">
                    <span className="drag-handle" aria-hidden>
                      ⋮⋮
                    </span>
                    <span className="truncate">{c.name}</span>
                    {c.excludeFromBudget && excludedBadge}
                    {categoryActions(c)}
                  </div>
                  <div className="amount">
                    {c.excludeFromBudget ? null : editing === c.id ? (
                      <BudgetInput initial={c.budgeted} onDone={(amount, step) => finishEdit(c, amount, step)} />
                    ) : (
                      <button
                        className="budget-cell"
                        onClick={() => setEditing(c.id)}
                        aria-label={`Budget for ${c.name}`}
                      >
                        {formatCents(shownBudgeted(c))}
                      </button>
                    )}
                  </div>
                  <div className="amount">
                    <button className="activity-cell" onClick={() => setActivityFor(c)}>
                      {formatCents(c.activity)}
                    </button>
                  </div>
                  <div className="amount">{!c.excludeFromBudget && <BalancePill cents={c.balance} />}</div>
                </div>
              ))}
            </div>
          ))}

          <div className="budget-row budget-head income-head">
            <div>Income</div>
            <div />
            <div className="amount">Received</div>
            <div />
          </div>
          {incomeGroups.map((g) => (
            <div key={g.id} className={g.hidden ? "budget-group hidden" : "budget-group"}>
              <div
                className={`budget-row group-row ${groupDropHint}${dropClass(`g${g.id}`)}`}
                {...dragProps({ kind: "group", id: g.id, isIncome: true })}
                {...dropOnGroup(g)}
              >
                <div className="name">
                  <span className="drag-handle" aria-hidden>
                    ⋮⋮
                  </span>
                  <span className="truncate">{g.name}</span>
                  {groupActions(g)}
                </div>
                <div />
                <Money className="amount" cents={g.activity} />
                <div />
              </div>
              {g.categories.filter(visible).map((c) => (
                <div
                  key={c.id}
                  className={`budget-row category-line${c.hidden ? " hidden" : ""}${c.excludeFromBudget ? " excluded" : ""} drop-before${dropClass(`c${c.id}`)}`}
                  {...dragProps({ kind: "category", id: c.id })}
                  {...dropOnCategory(g, c)}
                >
                  <div className="name">
                    <span className="drag-handle" aria-hidden>
                      ⋮⋮
                    </span>
                    <span className="truncate">{c.name}</span>
                    {c.excludeFromBudget && excludedBadge}
                    {c.forNextMonth && (
                      <span className="badge" title="Received last month, budgeted this month">
                        From {monthName(addMonths(month, -1))}
                      </span>
                    )}
                    {categoryActions(c, true)}
                  </div>
                  <div />
                  <div className="amount">
                    <button className="activity-cell" onClick={() => setActivityFor(c)}>
                      {formatCents(c.activity)}
                    </button>
                  </div>
                  <div />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {activityFor && <ActivityDialog month={month} category={activityFor} onClose={() => setActivityFor(null)} />}
    </>
  );
}
