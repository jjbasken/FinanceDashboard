import { type BudgetCategory } from "@fd/shared";
import { useState } from "react";
import { useAuthStatus } from "../auth";
import { usePreferences } from "../preferences";
import { today, useAccounts, useBudgetOnlyAccount, useCategories, usePayees } from "../ledger";
import { useLookups } from "./registerModel";
import { TransactionEditor } from "./TransactionEditor";
import { Dialog } from "./Dialog";
import { entryAccounts, needsNoAccount } from "./entryAccounts";

export function QuickEntry(props: { onClose: () => void; category?: BudgetCategory; isIncome?: boolean; month?: string; accountId?: number }) {
  const accounts = useAccounts(); const payees = usePayees(); const categories = useCategories();
  const { data: auth } = useAuthStatus();
  const key = `fd.lastAccount.${auth?.household?.id}.${auth?.user?.id}`;
  const [chosen, setChosen] = useState<number | null>(() => { try { return props.accountId ?? (Number(localStorage.getItem(key)) || null); } catch { return props.accountId ?? null; } });
  const { preferences } = usePreferences();
  const [showAll, setShowAll] = useState(false);
  const open = (accounts.data ?? []).filter(a => !a.closed && (!props.category || a.onBudget));
  const budgetOnly = useBudgetOnlyAccount();
  const { account, shown } = entryAccounts(open, preferences.entryAccounts, chosen, showAll, props.accountId, budgetOnly.data);
  const lookups = useLookups(account ?? { id: 0 } as never, accounts.data ?? [], payees.data ?? [], categories.data ?? []);
  // If "No account" can't be loaded, entry still works with the real accounts.
  const error = accounts.error ?? (needsNoAccount(open, props.accountId) ? budgetOnly.error : null) ?? payees.error ?? categories.error;
  if (error || !accounts.data || budgetOnly.isPending || !account || !payees.data || !categories.data) return <Dialog title="Add purchase" submitLabel="Close" noCancel onClose={props.onClose} onSubmit={props.onClose} error={error?.message}>
    {!error && <p>Loading accounts…</p>}
  </Dialog>;
  return <TransactionEditor lookups={lookups} onClose={props.onClose} initialCategory={props.category?.id} initialIncome={props.isIncome}
    initialDate={props.month && props.month !== today().slice(0,7) ? `${props.month}-01` : today()}
    accountOptions={shown} onShowAllAccounts={shown.filter(a => !a.budgetOnly).length < open.length ? () => { setChosen(account.id); setShowAll(true); } : undefined} onAccountChange={setChosen} onSaved={() => { if (account.budgetOnly) return; /* "No account" is never remembered */ try { localStorage.setItem(key, String(account.id)); } catch {} }} />;
}
