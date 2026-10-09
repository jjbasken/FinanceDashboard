import type { Account, Transaction } from "@fd/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useAccounts, useCategories, usePayees } from "../ledger";
import { Dialog } from "./Dialog";
import { TransactionEditor } from "./TransactionEditor";
import { linkedKind, LinkedNotice, useLookups } from "./registerModel";
export function EditTransaction({ id, onClose }: { id: number; onClose: () => void }) {
  const accounts = useAccounts(); const categories = useCategories(); const payees = usePayees();
  const query = useQuery({ queryKey: ["transaction", id], queryFn: () => api.get<Transaction>(`/transactions/${id}`) });
  const account = accounts.data?.find(a => a.id === query.data?.accountId);
  const lookups = useLookups(account ?? { id: 0 } as Account, accounts.data ?? [], payees.data ?? [], categories.data ?? []);
  const error = query.error ?? accounts.error ?? categories.error ?? payees.error;
  const kind = query.data && linkedKind(query.data);
  if (kind || error || !query.data || !account || !categories.data || !payees.data) return <Dialog title="Review transaction" submitLabel="Close" noCancel onClose={onClose} onSubmit={onClose} error={error?.message}>
    {kind ? <LinkedNotice kind={kind} onDismiss={onClose} /> : !error && <p>Loading transaction…</p>}
  </Dialog>;
  return <TransactionEditor transaction={query.data} lookups={lookups} onClose={onClose} />;
}
