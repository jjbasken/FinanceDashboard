import { expect, test } from "bun:test";
import { createScheduledBillInput, describeSchedule, nextOccurrence, occurrencesInMonth } from "./schedules";

const bill = (frequency: "monthly" | "weekly" | "biweekly" | "yearly", startDate: string, endDate: string | null = null) => ({
  frequency,
  startDate,
  endDate,
});

test("monthly bills on the 31st fall on the last day of shorter months", () => {
  const rent = bill("monthly", "2026-01-31");
  expect(occurrencesInMonth(rent, "2026-01")).toEqual(["2026-01-31"]);
  expect(occurrencesInMonth(rent, "2026-02")).toEqual(["2026-02-28"]);
  expect(occurrencesInMonth(rent, "2028-02")).toEqual(["2028-02-29"]);
  expect(occurrencesInMonth(rent, "2026-04")).toEqual(["2026-04-30"]);
});

test("nothing before the first due date or after the end date", () => {
  const phone = bill("monthly", "2026-10-15", "2027-01-14");
  expect(occurrencesInMonth(phone, "2026-09")).toEqual([]);
  expect(occurrencesInMonth(phone, "2026-10")).toEqual(["2026-10-15"]);
  expect(occurrencesInMonth(phone, "2026-12")).toEqual(["2026-12-15"]);
  expect(occurrencesInMonth(phone, "2027-01")).toEqual([]);
});

test("weekly and every-2-weeks bills step from the first due date", () => {
  const pay = bill("biweekly", "2026-10-02");
  expect(occurrencesInMonth(pay, "2026-10")).toEqual(["2026-10-02", "2026-10-16", "2026-10-30"]);
  expect(occurrencesInMonth(pay, "2026-11")).toEqual(["2026-11-13", "2026-11-27"]);
  expect(occurrencesInMonth(bill("weekly", "2026-10-28"), "2026-10")).toEqual(["2026-10-28"]);
  expect(occurrencesInMonth(bill("weekly", "2026-10-28"), "2026-11")).toEqual([
    "2026-11-04",
    "2026-11-11",
    "2026-11-18",
    "2026-11-25",
  ]);
});

test("yearly bills come up once a year, leap days on the 28th otherwise", () => {
  const insurance = bill("yearly", "2024-02-29");
  expect(occurrencesInMonth(insurance, "2026-01")).toEqual([]);
  expect(occurrencesInMonth(insurance, "2026-02")).toEqual(["2026-02-28"]);
  expect(occurrencesInMonth(insurance, "2028-02")).toEqual(["2028-02-29"]);
});

test("nextOccurrence", () => {
  expect(nextOccurrence(bill("monthly", "2026-01-15"), "2026-10-08")).toBe("2026-10-15");
  expect(nextOccurrence(bill("monthly", "2026-01-05"), "2026-10-08")).toBe("2026-11-05");
  expect(nextOccurrence(bill("monthly", "2026-12-01"), "2026-10-08")).toBe("2026-12-01");
  expect(nextOccurrence(bill("yearly", "2026-03-03"), "2026-10-08")).toBe("2027-03-03");
  expect(nextOccurrence(bill("monthly", "2026-01-05", "2026-10-01"), "2026-10-08")).toBeNull();
});

test("describeSchedule", () => {
  expect(describeSchedule(bill("monthly", "2026-10-15"))).toBe("Monthly on the 15th");
  expect(describeSchedule(bill("monthly", "2026-10-01"))).toBe("Monthly on the 1st");
  expect(describeSchedule(bill("monthly", "2026-10-22"))).toBe("Monthly on the 22nd");
  expect(describeSchedule(bill("monthly", "2026-10-31"))).toBe("Monthly on the last day");
  expect(describeSchedule(bill("biweekly", "2026-10-02"))).toBe("Every 2 weeks on Friday");
  expect(describeSchedule(bill("yearly", "2026-03-03"))).toBe("Yearly on March 3");
});

test("the end date can't come before the first due date", () => {
  const base = { accountId: 1, amount: -100, frequency: "monthly", startDate: "2026-10-15" };
  expect(createScheduledBillInput.safeParse({ ...base, endDate: "2026-10-14" }).success).toBe(false);
  expect(createScheduledBillInput.safeParse({ ...base, endDate: "2026-10-15" }).success).toBe(true);
});
