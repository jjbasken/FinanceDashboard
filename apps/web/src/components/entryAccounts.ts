import type { Account } from "@fd/shared";

/** Resolve the selected account and its options from the eligible, open accounts. */
export function entryAccounts(open: Account[], preferred: number[], chosen: number | null, showAll: boolean, initialAccountId?: number) {
  const shortlist = showAll ? [] : open.filter(a => preferred.includes(a.id));
  const fallback = shortlist.find(a => a.onBudget && a.type !== "investment") ?? shortlist[0] ?? open.find(a => a.onBudget && a.type !== "investment") ?? open[0];
  const account = open.find(a => a.id === chosen && (a.id === initialAccountId || !shortlist.length || shortlist.includes(a))) ?? fallback;
  const initialAccount = open.find(a => a.id === initialAccountId);
  const shown = !shortlist.length ? open : initialAccount && !shortlist.includes(initialAccount) ? [initialAccount, ...shortlist] : shortlist;
  return { account, shown };
}
