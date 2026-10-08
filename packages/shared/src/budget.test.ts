import { expect, test } from "bun:test";
import {
  addMonths,
  describeMonthMask,
  formatMonth,
  formatMonthMask,
  maskMonths,
  monthInMask,
  monthSchema,
} from "./budget";

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

const JAN = 1 << 0;
const MAR = 1 << 2;
const JUL = 1 << 6;
const DEC = 1 << 11;

test("monthInMask", () => {
  expect(monthInMask(MAR, "2026-03")).toBe(true);
  expect(monthInMask(MAR, "2026-04")).toBe(false);
  expect(monthInMask(JAN | DEC, "2026-12")).toBe(true);
  expect(monthInMask(0, "2026-03")).toBe(false);
});

test("maskMonths lists months in calendar order", () => {
  expect(maskMonths(DEC | JAN | JUL)).toEqual([1, 7, 12]);
  expect(maskMonths(0)).toEqual([]);
  expect(maskMonths(0xfff)).toHaveLength(12);
});

test("formatMonthMask and describeMonthMask", () => {
  expect(formatMonthMask(MAR)).toBe("Mar");
  expect(formatMonthMask(JAN | JUL)).toBe("Jan · Jul");
  expect(formatMonthMask(0b1111_1111)).toBe("8 months");
  expect(describeMonthMask(JAN | JUL)).toBe("January, July");
  expect(formatMonthMask(0)).toBe("");
});
