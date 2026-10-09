import { formatCents, type BillPayment } from "@fd/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { formatDate, today, useAccounts, useLedgerMutation, usePayees, useScheduledBills } from "../ledger";
import { EditTransaction } from "./EditTransaction";
import { askConfirm } from "./Feedback";

export function UpcomingBills({ limit }: { limit?: number }) {
  const bills = useScheduledBills(); const accounts = useAccounts(); const payees = usePayees();
  const posted = useQuery({ queryKey: ["scheduled-bills", "payments"], queryFn: () => api.get<BillPayment[]>("/scheduled-bills/payments") });
  const [editing, setEditing] = useState<number | null>(null);
  const confirm = useLedgerMutation((id: number) => api.patch(`/transactions/${id}`, { cleared: true }));
  const actual = posted.data ?? [];
  const next = (bills.data ?? []).filter(b => !b.paused && b.nextDue && !actual.some(p => p.scheduledBillId === b.id && p.date === b.nextDue)).map(b => ({ id: null, scheduledBillId: b.id, accountId: b.accountId, accountName: accounts.data?.find(a => a.id === b.accountId)?.name ?? "", payeeName: payees.data?.find(p => p.id === b.payeeId)?.name || b.notes || "Bill", date: b.nextDue!, amount: b.amount, cleared: false }));
  const rows = [...actual, ...next].filter(p => !limit || !p.cleared).sort((a,b) => Number(a.cleared) - Number(b.cleared) || a.date.localeCompare(b.date));
  const shown = limit ? rows.slice(0, limit) : rows;
  const error = posted.error ?? bills.error ?? accounts.error ?? payees.error ?? confirm.error;
  return <section className="card wide upcoming-bills"><div className="card-head"><h2>{limit ? "Bills coming up" : "Bill payments"}</h2>{limit && <Link to="/bills">View all →</Link>}</div>
    <p className="muted">These reminders record planned transactions. The app does not pay your bills.</p>
    {error && <p className="error-text" role="alert">{error.message}<button className="btn" onClick={() => { void posted.refetch(); void bills.refetch(); }}>Try again</button></p>}
    {(posted.isPending || bills.isPending) && <p role="status">Loading bills…</p>}
    {!posted.isPending && !bills.isPending && !error && shown.length === 0 && <p>No upcoming bills to review. <Link to="/bills">Manage recurring bills</Link></p>}
    <ul className="bill-payment-list">{shown.map(p => <li key={p.id ?? `next-${p.scheduledBillId}`}>
      <div><strong>{p.payeeName || "Bill"}</strong><span className="muted">{formatDate(p.date)} · {p.accountName}</span>
      <span className={`payment-status ${!p.cleared && p.date < today() ? "negative" : ""}`}>{p.cleared ? "Confirmed · marked cleared" : p.date < today() ? "Past due date · not confirmed" : p.date === today() ? "Due today · not confirmed" : p.id ? "Scheduled · not confirmed" : "Upcoming · not recorded yet"}</span></div>
      <strong className="amount">{formatCents(Math.abs(p.amount))}</strong>
      {!limit && p.id && !p.cleared && <div className="payment-actions"><button className="btn" onClick={() => setEditing(p.id!)}>Review / adjust</button><button className="btn" disabled={confirm.isPending} onClick={async () => { if (await askConfirm(`Have you checked that ${p.payeeName || "this payment"} for ${formatCents(Math.abs(p.amount))} on ${formatDate(p.date)} appears at your bank? This marks the existing entry as cleared; it does not send a payment.`)) confirm.mutate(p.id!); }}>Confirm bank payment</button></div>}
    </li>)}</ul>
    {editing && <EditTransaction id={editing} onClose={() => setEditing(null)} />}
  </section>;
}
