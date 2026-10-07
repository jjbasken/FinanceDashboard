import type { Category, CategoryGroup } from "@fd/shared";
import { useState } from "react";
import { api } from "../api";
import { useCategories, useLedgerMutation } from "../ledger";
import { Dialog } from "./Dialog";

function DeleteCategoryDialog(props: { category: Category; groups: CategoryGroup[]; onClose: () => void }) {
  const [transferTo, setTransferTo] = useState("");
  const remove = useLedgerMutation(() =>
    api.delete(`/categories/${props.category.id}${transferTo ? `?transferTo=${transferTo}` : ""}`),
  );
  return (
    <Dialog
      title={`Delete "${props.category.name}"`}
      submitLabel="Delete category"
      danger
      onClose={props.onClose}
      onSubmit={() => remove.mutate(undefined, { onSuccess: props.onClose })}
      pending={remove.isPending}
      error={remove.error?.message}
    >
      <label className="field">
        <span>Move its transactions to</span>
        <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
          <option value="">Leave them uncategorized</option>
          {props.groups.map((g) => (
            <optgroup key={g.id} label={g.name}>
              {g.categories
                .filter((c) => c.id !== props.category.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
    </Dialog>
  );
}

export function CategoriesCard() {
  const { data: groups, error } = useCategories();
  const [deleting, setDeleting] = useState<Category | null>(null);
  const mutate = useLedgerMutation(({ method, path, body }: { method: "post" | "patch" | "delete"; path: string; body?: unknown }) =>
    method === "delete" ? api.delete(path) : api[method](path, body),
  );

  function ask(label: string, initial = "") {
    return prompt(label, initial)?.trim() || null;
  }

  function addGroup(isIncome: boolean) {
    const name = ask("New category group name");
    if (name) mutate.mutate({ method: "post", path: "/categories/groups", body: { name, isIncome } });
  }

  return (
    <section className="card">
      <h2>Categories</h2>
      <p className="muted">Budget categories, grouped. Hidden categories stay on old transactions but drop out of pickers.</p>
      {error && <p className="error-text">{error.message}</p>}
      {mutate.error && <p className="error-text">{mutate.error.message}</p>}
      {groups?.map((g) => (
        <div key={g.id} className={g.hidden ? "category-group hidden" : "category-group"}>
          <div className="category-row group">
            <strong>{g.name}</strong>
            {g.isIncome && <span className="badge">Income</span>}
            <span className="spacer" />
            <button
              className="link-button"
              onClick={() => {
                const name = ask(`New category in ${g.name}`);
                if (name) mutate.mutate({ method: "post", path: "/categories", body: { groupId: g.id, name } });
              }}
            >
              Add category
            </button>
            <button
              className="link-button"
              onClick={() => {
                const name = ask("Rename group", g.name);
                if (name) mutate.mutate({ method: "patch", path: `/categories/groups/${g.id}`, body: { name } });
              }}
            >
              Rename
            </button>
            <button
              className="link-button"
              onClick={() => mutate.mutate({ method: "patch", path: `/categories/groups/${g.id}`, body: { hidden: !g.hidden } })}
            >
              {g.hidden ? "Show" : "Hide"}
            </button>
            <button
              className="link-button danger"
              onClick={() => {
                const msg = `Delete the "${g.name}" group and its ${g.categories.length} categories? Their transactions become uncategorized.`;
                if (confirm(msg)) mutate.mutate({ method: "delete", path: `/categories/groups/${g.id}` });
              }}
            >
              Delete
            </button>
          </div>
          {g.categories.map((c) => (
            <div key={c.id} className={c.hidden ? "category-row hidden" : "category-row"}>
              <span>{c.name}</span>
              {c.hidden && <span className="badge">Hidden</span>}
              {g.isIncome && c.forNextMonth && !c.excludeFromBudget && <span className="badge">Budgeted next month</span>}
              {c.excludeFromBudget && <span className="badge">Not in budget</span>}
              <span className="spacer" />
              {g.isIncome && !c.excludeFromBudget && (
                <button
                  className="link-button"
                  title="Budget this income in the month after it arrives, e.g. pay that lands at the end of the month"
                  onClick={() =>
                    mutate.mutate({ method: "patch", path: `/categories/${c.id}`, body: { forNextMonth: !c.forNextMonth } })
                  }
                >
                  {c.forNextMonth ? "Use when received" : "Use next month"}
                </button>
              )}
              <button
                className="link-button"
                onClick={() => {
                  const name = ask("Rename category", c.name);
                  if (name) mutate.mutate({ method: "patch", path: `/categories/${c.id}`, body: { name } });
                }}
              >
                Rename
              </button>
              <button
                className="link-button"
                onClick={() => mutate.mutate({ method: "patch", path: `/categories/${c.id}`, body: { hidden: !c.hidden } })}
              >
                {c.hidden ? "Show" : "Hide"}
              </button>
              <button
                className="link-button"
                title="Keep this category out of the budget and reports, e.g. reimbursable work expenses"
                onClick={() =>
                  mutate.mutate({
                    method: "patch",
                    path: `/categories/${c.id}`,
                    body: { excludeFromBudget: !c.excludeFromBudget },
                  })
                }
              >
                {c.excludeFromBudget ? "Include in budget" : "Exclude from budget"}
              </button>
              <button className="link-button danger" onClick={() => setDeleting(c)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      ))}
      <div className="row-actions">
        <button className="btn" onClick={() => addGroup(false)}>
          Add group
        </button>
        <button className="btn" onClick={() => addGroup(true)}>
          Add income group
        </button>
      </div>
      {deleting && groups && <DeleteCategoryDialog category={deleting} groups={groups} onClose={() => setDeleting(null)} />}
    </section>
  );
}
