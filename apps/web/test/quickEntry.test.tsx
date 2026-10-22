import { expect, test } from "bun:test";
import type { Account } from "@fd/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { QuickEntry } from "../src/components/QuickEntry";
import { EditTransaction } from "../src/components/EditTransaction";
import { ledgerKeys } from "../src/ledger";

const checking = { id: 1, name: "Checking", type: "checking", onBudget: true } as Account;
const noAccount = { id: 2, name: "No account", type: "cash", onBudget: true, budgetOnly: true } as Account;

function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  qc.setQueryData(ledgerKeys.payees, []);
  qc.setQueryData(ledgerKeys.categories, []);
  return qc;
}

function entry(qc: QueryClient, accountId?: number) {
  return renderToStaticMarkup(<QueryClientProvider client={qc}><QuickEntry accountId={accountId} onClose={() => {}} /></QueryClientProvider>);
}

test("entry waits for real accounts before offering the budget-only fallback", () => {
  const qc = client();
  qc.setQueryData([...ledgerKeys.accounts, "budget-only"], noAccount);
  expect(entry(qc)).toContain("Loading accounts");
  expect(entry(qc)).not.toContain("Save purchase");
});

test("entry from No account waits for its lookup instead of offering a real account", () => {
  const qc = client();
  qc.setQueryData(ledgerKeys.accounts, [checking]);
  expect(entry(qc, noAccount.id)).toContain("Loading accounts");
  expect(entry(qc, noAccount.id)).not.toContain("Save purchase");
});

test("editing a budget-only purchase reports lookup errors", () => {
  const qc = client();
  qc.setQueryData(ledgerKeys.accounts, [checking]);
  qc.setQueryData(["transaction", 7], { id: 7, accountId: noAccount.id });
  const query = qc.getQueryCache().build(qc, { queryKey: [...ledgerKeys.accounts, "budget-only"] });
  query.setState({ status: "error", error: new Error("Cannot load budget-only account") });
  const html = renderToStaticMarkup(<QueryClientProvider client={qc}><EditTransaction id={7} onClose={() => {}} /></QueryClientProvider>);
  expect(html).toContain("Cannot load budget-only account");
  expect(html).not.toContain("Loading transaction");
});

function failBudgetOnly(qc: QueryClient) {
  const query = qc.getQueryCache().build(qc, { queryKey: [...ledgerKeys.accounts, "budget-only"] });
  query.setState({ status: "error", error: new Error("Cannot load budget-only account") });
}

test("entry that needs No account reports when it can't be loaded", () => {
  const fromNoAccount = client();
  fromNoAccount.setQueryData(ledgerKeys.accounts, [checking]);
  failBudgetOnly(fromNoAccount);
  expect(entry(fromNoAccount, noAccount.id)).toContain("Cannot load budget-only account");

  const nothingElse = client();
  nothingElse.setQueryData(ledgerKeys.accounts, []);
  failBudgetOnly(nothingElse);
  expect(entry(nothingElse)).toContain("Cannot load budget-only account");
});
