import { Navigate, Route, Routes } from "react-router";
import { useAuthStatus } from "./auth";
import { AppShell } from "./components/AppShell";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { LoginPage } from "./pages/LoginPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";

export function App() {
  const { data: status, isPending, error } = useAuthStatus();

  if (isPending) return <div className="fullscreen-center muted">Loading…</div>;
  if (error) return <div className="fullscreen-center error-text">Can't reach the server: {error.message}</div>;

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
        <Route path="/budget" element={<PlaceholderPage title="Budget" milestone="Budget" />} />
        <Route path="/reports" element={<PlaceholderPage title="Reports" milestone="Reports" />} />
        <Route path="/investments" element={<PlaceholderPage title="Investments" milestone="Investments" />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/budget" replace />} />
      </Route>
    </Routes>
  );
}
