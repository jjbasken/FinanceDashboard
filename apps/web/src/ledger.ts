import type {
  Account,
  BudgetMonth,
  CategoryGroup,
  HoldingsSummary,
  InvestmentTxn,
  Payee,
  PublicUser,
  Security,
  Transaction,
  ValuePoint,
} from "@fd/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const ledgerKeys = {
  accounts: ["accounts"] as const,
  categories: ["categories"] as const,
  payees: ["payees"] as const,
  members: ["household", "users"] as const,
  register: (accountId: number) => ["register", accountId] as const,
  budget: (month: string) => ["budget", month] as const,
};

export const useAccounts = () =>
  useQuery({ queryKey: ledgerKeys.accounts, queryFn: () => api.get<Account[]>("/accounts") });

export const useCategories = () =>
  useQuery({ queryKey: ledgerKeys.categories, queryFn: () => api.get<CategoryGroup[]>("/categories") });

export const usePayees = () => useQuery({ queryKey: ledgerKeys.payees, queryFn: () => api.get<Payee[]>("/payees") });

export const useMembers = () =>
  useQuery({ queryKey: ledgerKeys.members, queryFn: () => api.get<PublicUser[]>("/household/users") });

export const useRegister = (accountId: number) =>
  useQuery({
    queryKey: ledgerKeys.register(accountId),
    queryFn: () => api.get<Transaction[]>(`/accounts/${accountId}/transactions`),
  });

/**
 * A mutation that refreshes everything a ledger change can touch. Transfers change two
 * registers and new payees appear as a side effect, so refresh broadly; it's cheap.
 */
export function useLedgerMutation<TInput, TResult = unknown>(fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ledgerKeys.accounts }),
        qc.invalidateQueries({ queryKey: ["register"] }),
        qc.invalidateQueries({ queryKey: ledgerKeys.payees }),
        qc.invalidateQueries({ queryKey: ledgerKeys.categories }),
        qc.invalidateQueries({ queryKey: ["budget"] }),
        qc.invalidateQueries({ queryKey: ["investments"] }),
      ]),
  });
}

export const useBudget = (month: string) =>
  useQuery({
    queryKey: ledgerKeys.budget(month),
    queryFn: () => api.get<BudgetMonth>(`/budget/${month}`),
    placeholderData: (prev) => prev,
  });

export const useSecurities = () =>
  useQuery({ queryKey: ["investments", "securities"], queryFn: () => api.get<Security[]>("/investments/securities") });

export const useHoldings = () =>
  useQuery({ queryKey: ["investments", "holdings"], queryFn: () => api.get<HoldingsSummary>("/investments/holdings") });

export const useInvestmentTxns = () =>
  useQuery({
    queryKey: ["investments", "transactions"],
    queryFn: () => api.get<InvestmentTxn[]>("/investments/transactions"),
  });

export const useValueHistory = (range: string) =>
  useQuery({
    queryKey: ["investments", "history", range],
    queryFn: () => api.get<ValuePoint[]>(`/investments/history?range=${range}`),
    placeholderData: (prev) => prev,
  });

/** Today's date in the browser's time zone, as YYYY-MM-DD. */
export function today() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Format a YYYY-MM-DD date for display without time-zone surprises. */
export function formatDate(date: string) {
  const [y, m, d] = date.split("-");
  return `${m}/${d}/${y}`;
}

/** The current month as YYYY-MM. */
export const thisMonth = () => today().slice(0, 7);
