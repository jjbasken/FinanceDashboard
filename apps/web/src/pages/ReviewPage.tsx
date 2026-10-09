import { addMonths, formatCents, formatMonth, monthSchema } from "@fd/shared";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { formatDate, thisMonth, useReview } from "../ledger";
import { EditTransaction } from "../components/EditTransaction";
export function ReviewPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("month");
  const month = requested && monthSchema.safeParse(requested).success ? requested : thisMonth();
  const review = useReview(month);
  const [editing, setEditing] = useState<number | null>(null);
  return <>
    <header className="page-header"><h1>Purchases to review</h1><p className="muted">Give these transactions a category so your monthly plan includes them.</p>
      <div className="month-nav"><button className="btn" aria-label="Previous month" onClick={() => setParams({ month: addMonths(month, -1) })}>‹</button><h2>{formatMonth(month)}</h2><button className="btn" aria-label="Next month" onClick={() => setParams({ month: addMonths(month, 1) })}>›</button></div>
    </header>
    <div className="page-body">
      {review.isPending && <p role="status">Loading purchases…</p>}
      {review.error && <p className="error-text" role="alert">{review.error.message}<button className="btn" onClick={() => review.refetch()}>Try again</button></p>}
      {review.data?.length === 0 && <section className="card"><h2>All caught up</h2><p>Every transaction that needs a category this month has one.</p></section>}
      <ul className="review-list">{review.data?.map(t => <li key={t.id} className="card review-item">
        <div><strong>{t.payeeName || t.notes || "No payee"}</strong><p className="muted">{formatDate(t.date)} · {t.accountName}{t.id !== t.transactionId && " · Split transaction"}</p>
        {t.privateAccount && <small>Included in the family budget. Only the account owner can edit it.</small>}</div>
        <strong className="amount">{formatCents(t.amount)}</strong>
        {!t.privateAccount && <button className="btn" onClick={() => setEditing(t.transactionId)}>Choose category</button>}
      </li>)}</ul>
    </div>
    {editing !== null && <EditTransaction id={editing} onClose={() => setEditing(null)} />}
  </>;
}
