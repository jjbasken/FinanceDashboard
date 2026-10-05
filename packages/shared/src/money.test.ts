import { describe, expect, test } from "bun:test";
import { formatCents, parseCents, rationalToCents } from "./money";

describe("parseCents", () => {
  test.each([
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    ["$1,234.56", 123456],
    ["-0.05", -5],
    ["(45.10)", -4510],
    [".5", 50],
    ["+7", 700],
  ])("%p -> %p", (input, cents) => {
    expect(parseCents(input)).toBe(cents);
  });

  test.each(["", "abc", "1.234", "1.2.3", "-", "."])("rejects %p", (input) => {
    expect(parseCents(input)).toBeNull();
  });
});

test("formatCents", () => {
  expect(formatCents(123456)).toBe("$1,234.56");
  expect(formatCents(-5)).toBe("-$0.05");
});

test("rationalToCents rounds half away from zero", () => {
  expect(rationalToCents(12345, 100)).toBe(12345);
  expect(rationalToCents(1, 1)).toBe(100);
  expect(rationalToCents(1005, 1000)).toBe(101);
  expect(rationalToCents(-1005, 1000)).toBe(-101);
});
