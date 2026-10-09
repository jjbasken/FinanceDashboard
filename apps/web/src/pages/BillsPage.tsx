import { askConfirm } from "../components/Feedback";
import { describeSchedule, formatCents, type ScheduledBill } from "@fd/shared";
import { useState } from "react";
import { api } from "../api";
import { UpcomingBills } from "../components/UpcomingBills";
import { BillDialog } from "../components/BillDialog";
import { formatDate, useAccounts, useCategories, useLedgerMutation, usePayees, useScheduledBills } from "../ledger";

export function BillsPage() {
  const bills = useScheduledBills();
  const accounts = useAccounts();
  const payees = usePayees();
  const categories = useCategories();
  const [editing, setEditing] = useState<ScheduledBill | "new" | null>(null);

  const setPaused = useLedgerMutation((b: { id: number; paused: boolean }) =>
    api.patch(`/scheduled-bills/${b.id}`, { paused: b.paused }),
  );
  const remove = useLedgerMutation((id: number) => api.delete(`/scheduled-bills/${id}`));

  const accountName = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
  const payeeName = new Map(
    (payees.data ?? []).map((p) => [p.id, p.transferAccountId ? `Transfer: ${p.name}` : p.name]),
  );
  const categoryName = new Map((categories.data ?? []).flatMap((g) => g.categories).map((c) => [c.id, c.name]));
  const error = bills.error ?? setPaused.error ?? remove.error;

  return (
    <>
      <header className="page-header budget-header">
        <h1>Bills</h1>
        <div className="row-actions">
          <button className="btn btn-primary" onClick={async () => setEditing("new")}>
            Add bill
          </button>
        </div>
      </header>
      <div className="page-body investments">
        <UpcomingBills />
        <section className="card wide">
          <h2>Recurring schedules</h2>
          <p className="muted">
            Each month’s scheduled payments are recorded automatically. Review or adjust the existing entry when the payment appears at your bank. Importing a statement can match it automatically. Editing a schedule only affects payments not yet recorded.
          </p>
          {error && <p className="error-text">{error.message}</p>}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th className="bill-detail">Account</th>
                  <th className="bill-detail">Category</th>
                  <th className="bill-detail">Repeats</th>
                  <th className="bill-detail">Next due</th>
                  <th className="amount">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bills.data?.map((b) => {
                  const nextDue = b.nextDue ? formatDate(b.nextDue) : "Ended";
                  return (
                  <tr key={b.id} className={b.paused ? "muted" : undefined}>
                    <td className="bill-payee">
                      {(b.payeeId != null && payeeName.get(b.payeeId)) || b.notes || <span className="muted">No payee</span>}
                      {b.paused && <span className="badge bill-paused">paused</span>}
                      <small className="bill-summary muted">
                        {describeSchedule(b)} · {accountName.get(b.accountId)}
                        {!b.paused && ` · ${nextDue}`}
                      </small>
                    </td>
                    <td className="bill-detail">{accountName.get(b.accountId)}</td>
                    <td className="bill-detail">{b.categoryId != null ? categoryName.get(b.categoryId) : ""}</td>
                    <td className="bill-detail">{describeSchedule(b)}</td>
                    <td className="bill-detail">{b.paused ? "—" : nextDue}</td>
                    <td className={b.amount < 0 ? "amount negative" : "amount positive"}>{formatCents(b.amount)}</td>
                    <td className="amount">
                      <span className="row-actions-cell">
                        <button className="link-button" onClick={async () => setEditing(b)}>
                          Edit
                        </button>
                        <button
                          className="link-button bill-detail"
                          onClick={async () => setPaused.mutate({ id: b.id, paused: !b.paused })}
                        >
                          {b.paused ? "Resume" : "Pause"}
                        </button>
                        <button
                          className="link-button danger bill-detail"
                          onClick={async () =>
                            (await askConfirm("Delete this recurring bill? Payments already in the register stay.")) &&
                            remove.mutate(b.id)
                          }
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {bills.data?.length === 0 && <p className="muted">No recurring bills yet.</p>}
          </div>
        </section>
      </div>
      {editing && <BillDialog bill={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
