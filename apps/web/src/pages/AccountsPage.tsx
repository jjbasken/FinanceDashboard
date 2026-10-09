import { useState } from "react";
import { QuickEntry } from "../components/QuickEntry";
import { SidebarAccounts } from "../components/SidebarAccounts";

/** The account list as a page of its own, for phones (on a desktop it's in the sidebar). */
export function AccountsPage() {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <header className="page-header home-header">
        <h1>Accounts</h1><button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add purchase</button>
      </header>
      <div className="page-body">
        <div className="sidebar accounts-page">
          <SidebarAccounts />
        </div>
      </div>
      {adding && <QuickEntry onClose={() => setAdding(false)} />}
    </>
  );
}
