import { type BudgetCategory } from "@fd/shared";
import { useState } from "react";
import { useAuthStatus } from "../auth";
import { today, useAccounts, useCategories, usePayees } from "../ledger";
import { useLookups } from "./registerModel";
import { TransactionEditor } from "./TransactionEditor";
import { Dialog } from "./Dialog";
import { Link } from "react-router";

export function QuickEntry(props: { onClose: () => void; category?: BudgetCategory; isIncome?: boolean; month?: string; accountId?: number }) {
  const accounts = useAccounts(); const payees = usePayees(); const categories = useCategories();
  const { data: auth } = useAuthStatus();
  const key = `fd.lastAccount.${auth?.household?.id}.${auth?.user?.id}`;
  const [chosen, setChosen] = useState<number | null>(() => { try { return props.accountId ?? (Number(localStorage.getItem(key)) || null); } catch { return props.accountId ?? null; } });
  const open = (accounts.data ?? []).filter(a => !a.closed && (!props.category || a.onBudget));
  const account = open.find(a => a.id === chosen) ?? open.find(a => a.onBudget && a.type !== "investment") ?? open[0];
  const lookups = useLookups(account ?? { id: 0 } as never, accounts.data ?? [], payees.data ?? [], categories.data ?? []);
  const error = accounts.error ?? payees.error ?? categories.error;
  if (!account || !payees.data || !categories.data) return <Dialog title="Add purchase" submitLabel="Close" noCancel onClose={props.onClose} onSubmit={props.onClose} error={error?.message}>
    {!accounts.isPending && !account ? <p>Add an account first to record a purchase. <Link to="/accounts" onClick={props.onClose}>Open accounts</Link></p> : !error && <p>Loading accounts…</p>}
  </Dialog>;
  return <TransactionEditor lookups={lookups} onClose={props.onClose} initialCategory={props.category?.id} initialIncome={props.isIncome}
    initialDate={props.month && props.month !== today().slice(0,7) ? `${props.month}-01` : today()}
    accountOptions={open} onAccountChange={setChosen} onSaved={() => { try { localStorage.setItem(key, String(account.id)); } catch {} }} />;
}
