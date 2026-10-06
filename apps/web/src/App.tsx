import { lazy, type ReactNode, Suspense } from "react";
import { setDisplayCurrency } from "@fd/shared";
import { Navigate, Route, Routes } from "react-router";
import { useAuthStatus } from "./auth";
import { AppShell } from "./components/AppShell";
import { AccountPage } from "./pages/AccountPage";
import { BudgetPage } from "./pages/BudgetPage";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";

// Pages used less often (and the charting library) load on demand, keeping the first load small.
const InvestmentsPage = lazy(() => import("./pages/InvestmentsPage").then((m) => ({ default: m.InvestmentsPage })));
const ReportsPage = lazy(() => import("./pages/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const ImportPage = lazy(() => import("./pages/ImportPage").then((m) => ({ default: m.ImportPage })));
const PayeesPage = lazy(() => import("./pages/PayeesPage").then((m) => ({ default: m.PayeesPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));

const onDemand = (page: ReactNode) => (
  <Suspense fallback={<p className="muted page-error">Loading…</p>}>{page}</Suspense>
);

export function App() {
  const { data: status, isPending, error } = useAuthStatus();

  if (isPending) return <div className="fullscreen-center muted">Loading…</div>;
  if (error) return <div className="fullscreen-center error-text">Can't reach the server: {error.message}</div>;

  // Show amounts in the household's currency everywhere below.
  if (status.household) setDisplayCurrency(status.household.currency);

  if (status.needsSetup) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!status.user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<AcceptInvitePage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/budget" element={<BudgetPage />} />
        <Route path="/reports" element={onDemand(<ReportsPage />)} />
        <Route path="/investments" element={onDemand(<InvestmentsPage />)} />
        <Route path="/accounts/:id" element={<AccountPage />} />
        <Route path="/import" element={onDemand(<ImportPage />)} />
        <Route path="/payees" element={onDemand(<PayeesPage />)} />
        <Route path="/settings" element={onDemand(<SettingsPage />)} />
        <Route path="*" element={<Navigate to="/budget" replace />} />
      </Route>
    </Routes>
  );
}
