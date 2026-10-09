import { Link } from "react-router";
import { useAuthStatus } from "../auth";
import { usePreferences } from "../preferences";
export function MorePage() {
  const { data } = useAuthStatus(); const { preferences, update } = usePreferences();
  const links = [{ to: "/reports", title: "Reports", description: "See spending, income, and net worth." }, { to: "/investments", title: "Investments", description: "Holdings, prices, and investment history." }, { to: "/review", title: "Purchases to review", description: "Give uncategorized transactions a category." }, { to: "/import", title: "Import transactions", description: "Bring in a bank statement or finance history." }, { to: "/settings", title: "Settings", description: "Personal preferences, household, and categories." }];
  return <><header className="page-header"><h1>More</h1><p className="muted">Tools and settings for {data?.user?.displayName}.</p></header><div className="page-body">
    {links.map(l => <section className="card more-item" key={l.to}><div><Link to={l.to}><h2>{l.title} →</h2></Link><p className="muted">{l.description}</p></div>{["/reports", "/investments", "/review"].includes(l.to) && <label className="checkbox"><input type="checkbox" checked={preferences.shortcuts.includes(l.to)} onChange={e => update({ shortcuts: e.target.checked ? [...preferences.shortcuts, l.to] : preferences.shortcuts.filter(x => x !== l.to) })} /><span>Show shortcut</span></label>}</section>)}
  </div></>;
}
