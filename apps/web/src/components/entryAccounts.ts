import type { Account } from "@fd/shared";

/**
 * Resolve the selected account and its options from the eligible, open accounts. The budget-only
 * "No account", when given, is always the last option but only selected when chosen, or when
 * there's no other account to choose.
 */
export function entryAccounts(open: Account[], preferred: number[], chosen: number | null, showAll: boolean, initialAccountId?: number, noAccount?: Account) {
  const shortlist = showAll ? [] : open.filter(a => preferred.includes(a.id));
  const fallback = shortlist.find(a => a.onBudget && a.type !== "investment") ?? shortlist[0] ?? open.find(a => a.onBudget && a.type !== "investment") ?? open[0];
  const picked = open.find(a => a.id === chosen && (a.id === initialAccountId || !shortlist.length || shortlist.includes(a))) ?? fallback;
  const account = noAccount && (chosen === noAccount.id || !picked) ? noAccount : picked;
  const initialAccount = open.find(a => a.id === initialAccountId);
  const shown = !shortlist.length ? open : initialAccount && !shortlist.includes(initialAccount) ? [initialAccount, ...shortlist] : shortlist;
  return { account, shown: noAccount ? [...shown, noAccount] : shown };
}
