import { z } from "zod";
import { addMonths, monthOf } from "./budget";
import { centsSchema, dateSchema } from "./ledger";

export const BILL_FREQUENCIES = ["monthly", "weekly", "biweekly", "yearly"] as const;
export type BillFrequency = (typeof BILL_FREQUENCIES)[number];

const idSchema = z.number().int().positive();

const billFields = {
  accountId: idSchema,
  amount: centsSchema,
  /** An existing payee. A transfer payee makes each posted bill a transfer. */
  payeeId: idSchema.nullable(),
  /** Find or create a payee by name; ignored when payeeId is given. */
  payeeName: z.string().trim().max(100),
  categoryId: idSchema.nullable(),
  notes: z.string().trim().max(1000),
  frequency: z.enum(BILL_FREQUENCIES),
  /** The first due date. It also sets the day of the month, the weekday, or the date each year. */
  startDate: dateSchema,
  /** No occurrences after this date. */
  endDate: dateSchema.nullable(),
  /** Stop posting until it's resumed. */
  paused: z.boolean(),
};

const endAfterStart = (b: { startDate?: string; endDate?: string | null }) =>
  !b.startDate || !b.endDate || b.endDate >= b.startDate;
const endMessage = { message: "The end date must be on or after the first due date", path: ["endDate"] };

export const createScheduledBillInput = z
  .object(billFields)
  .partial()
  .extend({
    accountId: billFields.accountId,
    amount: billFields.amount,
    frequency: billFields.frequency,
    startDate: billFields.startDate,
  })
  .refine(endAfterStart, endMessage);
export type CreateScheduledBillInput = z.infer<typeof createScheduledBillInput>;

export const updateScheduledBillInput = z.object(billFields).partial().refine(endAfterStart, endMessage);
export type UpdateScheduledBillInput = z.infer<typeof updateScheduledBillInput>;

export interface ScheduledBill {
  id: number;
  accountId: number;
  amount: number;
  payeeId: number | null;
  categoryId: number | null;
  notes: string;
  frequency: BillFrequency;
  startDate: string;
  endDate: string | null;
  paused: boolean;
  /** The last month ("YYYY-MM") already posted to the register, or null if none yet. */
  postedThrough: string | null;
  /** The next due date on or after today, or null if the schedule has ended. */
  nextDue: string | null;
}

type Schedule = Pick<ScheduledBill, "frequency" | "startDate" | "endDate">;

const pad = (n: number) => String(n).padStart(2, "0");
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const fromDayNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

function daysInMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/** The given day of a month, moved back to the month's last day when it's shorter (31 → 30). */
function clampedDay(month: string, day: number) {
  return `${month}-${pad(Math.min(day, daysInMonth(month)))}`;
}

/** The dates a schedule falls on in a month ("YYYY-MM"), within its start and end dates. */
export function occurrencesInMonth(bill: Schedule, month: string): string[] {
  const startMonth = monthOf(bill.startDate);
  if (month < startMonth) return [];
  const startDay = Number(bill.startDate.slice(8, 10));
  let dates: string[];
  switch (bill.frequency) {
    case "monthly":
      dates = [clampedDay(month, startDay)];
      break;
    case "yearly":
      dates = month.slice(5) === bill.startDate.slice(5, 7) ? [clampedDay(month, startDay)] : [];
      break;
    case "weekly":
    case "biweekly": {
      const step = bill.frequency === "weekly" ? 7 : 14;
      const start = dayNumber(bill.startDate);
      const first = dayNumber(`${month}-01`);
      const last = first + daysInMonth(month) - 1;
      let d = start + Math.max(0, Math.ceil((first - start) / step)) * step;
      dates = [];
      for (; d <= last; d += step) dates.push(fromDayNumber(d));
      break;
    }
  }
  return dates.filter((d) => d >= bill.startDate && (!bill.endDate || d <= bill.endDate));
}

/** The first due date on or after `from`, or null once the schedule has ended. */
export function nextOccurrence(bill: Schedule, from: string): string | null {
  let month = monthOf(from < bill.startDate ? bill.startDate : from);
  // Yearly bills come up within 12 months; one extra covers a date late in the month.
  for (let i = 0; i < 14; i++, month = addMonths(month, 1)) {
    if (bill.endDate && `${month}-01` > bill.endDate) return null;
    const next = occurrencesInMonth(bill, month).find((d) => d >= from);
    if (next) return next;
  }
  return null;
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

/** "Monthly on the 15th", "Every 2 weeks on Friday", "Yearly on March 3". */
export function describeSchedule(bill: Pick<Schedule, "frequency" | "startDate">, locale = "en-US") {
  const date = new Date(`${bill.startDate}T00:00:00Z`);
  const day = Number(bill.startDate.slice(8, 10));
  switch (bill.frequency) {
    case "monthly":
      return day === 31 ? "Monthly on the last day" : `Monthly on the ${ordinal(day)}`;
    case "weekly":
    case "biweekly": {
      const weekday = date.toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" });
      return `${bill.frequency === "weekly" ? "Weekly" : "Every 2 weeks"} on ${weekday}`;
    }
    case "yearly":
      return `Yearly on ${date.toLocaleDateString(locale, { month: "long", day: "numeric", timeZone: "UTC" })}`;
  }
}
