import { useState } from "react";
import { api } from "../api";
import { useLedgerMutation } from "../ledger";
import { Dialog } from "./Dialog";

const NAMES = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.UTC(2000, i, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
);

/** Pick the months a category usually comes up in (a bitmask, bit 0 = January; 0 = every month). */
export function CategoryMonthsDialog(props: {
  category: { id: number; name: string; months: number };
  onClose: () => void;
}) {
  const [mask, setMask] = useState(props.category.months);
  const save = useLedgerMutation((months: number) => api.patch(`/categories/${props.category.id}`, { months }));

  return (
    <Dialog
      title={`Usual months: ${props.category.name}`}
      submitLabel="Save"
      onClose={props.onClose}
      onSubmit={() => save.mutate(mask, { onSuccess: props.onClose })}
      pending={save.isPending}
      error={save.error?.message}
    >
      <p className="muted">
        Pick the months this usually comes up. The budget will flag it in those months and dim it in the others.
      </p>
      <div className="month-picker" role="group" aria-label="Months">
        {NAMES.map((name, i) => {
          const on = (mask & (1 << i)) !== 0;
          return (
            <button
              key={name}
              type="button"
              className={on ? "active" : undefined}
              aria-pressed={on}
              onClick={() => setMask(mask ^ (1 << i))}
            >
              {name}
            </button>
          );
        })}
      </div>
      <button type="button" className="link-button month-picker-clear" onClick={() => setMask(0)} disabled={!mask}>
        Every month
      </button>
    </Dialog>
  );
}
