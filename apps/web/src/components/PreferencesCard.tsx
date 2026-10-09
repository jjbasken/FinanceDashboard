import { useEffect } from "react";
import { useAccounts, useCategories } from "../ledger";
import { usePreferences } from "../preferences";
export function PreferencesCard() {
  const { preferences: p, update } = usePreferences(); const accounts = useAccounts(); const categories = useCategories();
  useEffect(() => { if (window.location.hash === "#preferences") document.getElementById("preferences")?.scrollIntoView(); }, []);
  return <section className="card" id="preferences"><h2>Your everyday view</h2><p className="muted">These preferences are yours and are remembered in this browser. They do not change your partner’s view.</p>
    <label className="field"><span>Open after sign-in</span><select value={p.startPage} onChange={e => update({ startPage: e.target.value })}><option value="/home">Home overview</option><option value="/budget">Full budget</option><option value="/accounts">Accounts</option>{accounts.data?.filter(a => !a.closed).map(a => <option key={a.id} value={`/accounts/${a.id}`}>{a.name}</option>)}</select></label>
    <fieldset><legend>Favorite budget categories</legend><div className="preference-options">{categories.data?.filter(g => !g.isIncome && !g.hidden).flatMap(g => g.categories.filter(c => !c.hidden && !c.excludeFromBudget)).map(c => <label className="checkbox" key={c.id}><input type="checkbox" checked={p.favorites.includes(c.id)} onChange={e => update({ favorites: e.target.checked ? [...p.favorites, c.id] : p.favorites.filter(id => id !== c.id) })} /><span>{c.name}</span></label>)}</div></fieldset>
    <label className="checkbox"><input type="checkbox" checked={p.showRunningBalance} onChange={e => update({ showRunningBalance: e.target.checked })} /><span>Show running balances in compact transaction lists</span></label>
    <fieldset><legend>Personal shortcuts</legend>{[["/reports", "Reports"], ["/investments", "Investments"], ["/review", "Review purchases"]].map(([to, label]) => <label key={to} className="checkbox"><input type="checkbox" checked={p.shortcuts.includes(to!)} onChange={e => update({ shortcuts: e.target.checked ? [...p.shortcuts, to!] : p.shortcuts.filter(x => x !== to) })} /><span>{label}</span></label>)}</fieldset>
  </section>;
}
