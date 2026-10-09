import type { BudgetCategory } from "@fd/shared";
import { QuickEntry } from "./QuickEntry";
/** Category entry uses the same form as account and Home entry. */
export function TransactionDialog(props: { category: BudgetCategory; isIncome: boolean; month: string; onClose: () => void }) { return <QuickEntry {...props} />; }
