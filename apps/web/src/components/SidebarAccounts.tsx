import {
  accountSection,
  compareSidebarItems,
  formatCents,
  type Account,
  type AccountFolder,
  type AccountSection,
  type MoveSidebarItemInput,
  type SidebarItem,
} from "@fd/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type DragEvent, useState } from "react";
import { NavLink } from "react-router";
import { api } from "../api";
import { ledgerKeys, useAccounts, useFolders } from "../ledger";
import { AddAccountDialog } from "./AddAccountDialog";

const SECTIONS: { section: AccountSection; title: string }[] = [
  { section: "budget", title: "For budget" },
  { section: "offbudget", title: "Off budget" },
  { section: "investment", title: "Investments" },
];

/** Cash plus the market value of any investments held. */
const worth = (a: Account) => a.balance + a.holdingsValue;
const total = (list: Account[]) => list.reduce((sum, a) => sum + worth(a), 0);

function Money(props: { cents: number }) {
  return (
    <span className={props.cents < 0 ? "sidebar-amount negative" : "sidebar-amount"}>{formatCents(props.cents)}</span>
  );
}

type Node =
  | { kind: "account"; id: number; sortOrder: number; account: Account }
  | { kind: "folder"; id: number; sortOrder: number; folder: AccountFolder; children: Node[]; total: number };

const nodeTotal = (n: Node): number => (n.kind === "account" ? worth(n.account) : n.total);

/** One section's folders and accounts as a tree. Anything pointing at a missing folder goes to the top. */
function buildTree(accounts: Account[], folders: AccountFolder[]): Node[] {
  const ids = new Set(folders.map((f) => f.id));
  const parentOf = (id: number | null) => (id !== null && ids.has(id) ? id : null);
  const build = (parentId: number | null): Node[] =>
    [
      ...folders
        .filter((f) => parentOf(f.parentId) === parentId)
        .map((folder): Node => {
          const children = build(folder.id);
          const sum = children.reduce((s, c) => s + nodeTotal(c), 0);
          return { kind: "folder", id: folder.id, sortOrder: folder.sortOrder, folder, children, total: sum };
        }),
      ...accounts
        .filter((a) => parentOf(a.folderId) === parentId)
        .map((account): Node => ({ kind: "account", id: account.id, sortOrder: account.sortOrder, account })),
    ].sort(compareSidebarItems);
  return build(null);
}

const COLLAPSED_KEY = "fd.collapsedFolders";

/** Which folders this browser has collapsed. Storage can be unavailable, so it's best effort. */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as number[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (id: number) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // Not remembered, but it still works for this visit.
    }
  };
  return { collapsed, toggle };
}

type Drag = { item: SidebarItem; section: AccountSection };
/** Where a drop would put the dragged item, and which row shows it. */
type Drop = { key: string; mode: "before" | "into"; parentId: number | null; before: SidebarItem | null };

const ask = (label: string, initial = "") => prompt(label, initial)?.trim() || null;

/** An account's name, with a lock when it's private to you. */
function AccountName(props: { account: Account }) {
  return (
    <span className="truncate">
      {props.account.name}
      {props.account.private && (
        <span className="private-mark" title="Private: only you can see this account" aria-label="private">
          {" "}
          🔒
        </span>
      )}
    </span>
  );
}

export function SidebarAccounts() {
  const { data: accounts, error } = useAccounts();
  const { data: folders } = useFolders();
  const [adding, setAdding] = useState(false);
  const { collapsed, toggle } = useCollapsed();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const qc = useQueryClient();
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ledgerKeys.accounts }),
      qc.invalidateQueries({ queryKey: ledgerKeys.folders }),
    ]);
  const change = useMutation({
    mutationFn: ({ method, path, body }: { method: "post" | "patch" | "delete"; path: string; body?: unknown }) =>
      method === "delete" ? api.delete(path) : api[method](path, body),
    onSettled: refresh,
  });
  const move = (input: MoveSidebarItemInput) =>
    change.mutate({ method: "post", path: "/account-folders/move", body: input });

  const open = (accounts ?? []).filter((a) => !a.closed);
  const parents = new Map((folders ?? []).map((f) => [f.id, f.parentId]));
  /** Whether folder `id` is `ancestor` or inside it. */
  const within = (id: number | null, ancestor: number) => {
    for (let at = id; at !== null; at = parents.get(at) ?? null) if (at === ancestor) return true;
    return false;
  };

  // --- Drag and drop. An item drops before an account, before or into a folder, or at the end of its section.
  function canDrop(section: AccountSection, parentId: number | null, before: SidebarItem | null) {
    if (!drag || drag.section !== section) return false;
    if (before && before.kind === drag.item.kind && before.id === drag.item.id) return false;
    return drag.item.kind === "account" || !within(parentId, drag.item.id);
  }

  function dragProps(item: SidebarItem, section: AccountSection) {
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "");
        setDrag({ item, section });
      },
      onDragEnd: () => {
        setDrag(null);
        setDrop(null);
      },
    };
  }

  function dropProps(section: AccountSection, target: (e: DragEvent) => Drop) {
    return {
      onDragOver: (e: DragEvent) => {
        const d = target(e);
        if (!canDrop(section, d.parentId, d.before)) return;
        e.preventDefault();
        e.stopPropagation();
        if (d.key !== drop?.key || d.mode !== drop.mode) setDrop(d);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        const d = target(e);
        if (drag && canDrop(section, d.parentId, d.before)) {
          move({ item: drag.item, parentId: d.parentId, before: d.before });
        }
        setDrag(null);
        setDrop(null);
      },
    };
  }

  const dropClass = (key: string) =>
    drop?.key === key ? (drop.mode === "into" ? " drop-target drop-into" : " drop-target drop-before") : "";

  function renderNodes(nodes: Node[], section: AccountSection, parentId: number | null, depth: number) {
    const indent = { "--depth": depth } as CSSProperties;
    return nodes.map((n) => {
      if (n.kind === "account") {
        const key = `a${n.id}`;
        const item = { kind: "account", id: n.id } as const;
        return (
          <NavLink
            key={key}
            to={`/accounts/${n.id}`}
            className={`sidebar-account${dropClass(key)}`}
            style={indent}
            {...dragProps(item, section)}
            {...dropProps(section, () => ({ key, mode: "before", parentId, before: item }))}
          >
            <AccountName account={n.account} />
            <Money cents={worth(n.account)} />
          </NavLink>
        );
      }
      const { folder } = n;
      const key = `f${n.id}`;
      const item = { kind: "folder", id: n.id } as const;
      const isOpen = !collapsed.has(n.id);
      // The top third of a folder's row drops before it; the rest drops into it.
      const target = (e: DragEvent): Drop => {
        const box = e.currentTarget.getBoundingClientRect();
        return e.clientY < box.top + box.height / 3
          ? { key, mode: "before", parentId, before: item }
          : { key, mode: "into", parentId: n.id, before: null };
      };
      return (
        <div key={key} className="sidebar-folder">
          <div
            className={`sidebar-folder-row${dropClass(key)}`}
            style={indent}
            {...dragProps(item, section)}
            {...dropProps(section, target)}
          >
            <button className="sidebar-folder-toggle" onClick={() => toggle(n.id)} aria-expanded={isOpen}>
              <span className="caret">{isOpen ? "▾" : "▸"}</span>
              <span className="truncate">{folder.name}</span>
            </button>
            <span className="sidebar-actions">
              <button
                title="New folder inside"
                aria-label={`New folder inside ${folder.name}`}
                onClick={() => {
                  const name = ask(`New folder inside ${folder.name}`);
                  if (name) change.mutate({ method: "post", path: "/account-folders", body: { name, section, parentId: n.id } });
                }}
              >
                +
              </button>
              <button
                title="Rename folder"
                aria-label={`Rename ${folder.name}`}
                onClick={() => {
                  const name = ask("Rename folder", folder.name);
                  if (name && name !== folder.name) {
                    change.mutate({ method: "patch", path: `/account-folders/${n.id}`, body: { name } });
                  }
                }}
              >
                ✎
              </button>
              <button
                title="Delete folder"
                aria-label={`Delete ${folder.name}`}
                onClick={() => {
                  if (confirm(`Delete the "${folder.name}" folder? Its accounts and folders move out of it.`)) {
                    change.mutate({ method: "delete", path: `/account-folders/${n.id}` });
                  }
                }}
              >
                ×
              </button>
            </span>
            <Money cents={n.total} />
          </div>
          {isOpen && renderNodes(n.children, section, n.id, depth + 1)}
        </div>
      );
    });
  }

  const closed = (accounts ?? []).filter((a) => a.closed);

  return (
    <div className="sidebar-section" onDragLeave={() => setDrop(null)}>
      <div className="sidebar-section-title">
        <span>Accounts</span>
        {accounts && accounts.length > 0 && <Money cents={total(accounts)} />}
      </div>
      {error && <p className="sidebar-empty">{error.message}</p>}
      {change.error && <p className="sidebar-empty">{change.error.message}</p>}
      {accounts?.length === 0 && <p className="sidebar-empty">No accounts yet</p>}
      {SECTIONS.map(({ section, title }) => {
        const inSection = open.filter((a) => accountSection(a) === section);
        const sectionFolders = (folders ?? []).filter((f) => f.section === section);
        if (inSection.length === 0 && sectionFolders.length === 0) return null;
        const key = `s${section}`;
        return (
          <div key={section} className="sidebar-group">
            <div
              className={`sidebar-group-title${dropClass(key)}`}
              {...dropProps(section, () => ({ key, mode: "into", parentId: null, before: null }))}
            >
              <span>{title}</span>
              <span className="sidebar-actions">
                <button
                  title="New folder"
                  aria-label={`New folder in ${title}`}
                  onClick={() => {
                    const name = ask(`New folder in ${title}`);
                    if (name) change.mutate({ method: "post", path: "/account-folders", body: { name, section } });
                  }}
                >
                  + Folder
                </button>
              </span>
              <Money cents={total(inSection)} />
            </div>
            {renderNodes(buildTree(inSection, sectionFolders), section, null, 0)}
          </div>
        );
      })}
      <ClosedAccounts accounts={closed} />
      <button className="sidebar-add" onClick={() => setAdding(true)}>
        + Add account
      </button>
      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function ClosedAccounts(props: { accounts: Account[] }) {
  const [open, setOpen] = useState(false);
  if (props.accounts.length === 0) return null;
  return (
    <div className="sidebar-group">
      <button className="sidebar-group-title" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <span className="caret">{open ? "▾" : "▸"}</span>
          Closed
        </span>
      </button>
      {open &&
        props.accounts.map((a) => (
          <NavLink key={a.id} to={`/accounts/${a.id}`} className="sidebar-account">
            <AccountName account={a} />
            <Money cents={worth(a)} />
          </NavLink>
        ))}
    </div>
  );
}
