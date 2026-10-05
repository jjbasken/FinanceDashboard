import { expect, test } from "bun:test";
import { addMonths, formatMonth, monthSchema } from "./budget";

test("addMonths crosses year boundaries both ways", () => {
  expect(addMonths("2026-10", 1)).toBe("2026-11");
  expect(addMonths("2026-12", 1)).toBe("2027-01");
  expect(addMonths("2026-01", -1)).toBe("2025-12");
  expect(addMonths("2026-03", -15)).toBe("2024-12");
  expect(addMonths("2026-03", 0)).toBe("2026-03");
});

test("monthSchema", () => {
  expect(monthSchema.safeParse("2026-10").success).toBe(true);
  expect(monthSchema.safeParse("2026-13").success).toBe(false);
  expect(monthSchema.safeParse("2026-1").success).toBe(false);
});

test("formatMonth", () => {
  expect(formatMonth("2026-10")).toBe("October 2026");
});
