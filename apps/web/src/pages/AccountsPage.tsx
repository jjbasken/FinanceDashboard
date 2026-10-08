import { SidebarAccounts } from "../components/SidebarAccounts";

/** The account list as a page of its own, for phones (on a desktop it's in the sidebar). */
export function AccountsPage() {
  return (
    <>
      <header className="page-header">
        <h1>Accounts</h1>
      </header>
      <div className="page-body">
        <div className="sidebar accounts-page">
          <SidebarAccounts />
        </div>
      </div>
    </>
  );
}
