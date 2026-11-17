import { describe, expect, test } from "bun:test";
import { centsToInput, evaluateCents, formatCents, parseCents, rationalToCents, settleAmountText } from "./money";

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

describe("evaluateCents", () => {
  test.each([
    ["10+5.25", 1525],
    ["100/3", 3333],
    ["200/3", 6667],
    ["19.99*2-5", 3498],
    ["-5+3", -200],
    ["1,000 + $5", 100500],
    ["100*0.0825", 825],
    ["0.005*1", 1],
    ["-0.005*1", -1],
    ["10-20", -1000],
    ["12.50×3", 3750],
    ["9÷2", 450],
    ["2+3*4", 1400],
  ])("%p -> %p", (input, cents) => {
    expect(evaluateCents(input)).toBe(cents);
  });

  test.each(["12", "12.34", "$1,234.56", "-0.05", "(45.10)", ".5", "+7"])("matches parseCents for %p", (input) => {
    expect(evaluateCents(input)).toBe(parseCents(input));
  });

  test.each(["5/0", "5+", "*5", "5++", "", "abc", "1.2.3+1", "--5"])("rejects %p", (input) => {
    expect(evaluateCents(input)).toBeNull();
  });

  test("settleAmountText", () => {
    expect(settleAmountText("12.50*3")).toBe("37.50");
    expect(settleAmountText("12.5")).toBe("12.5");
    expect(settleAmountText("5+")).toBe("5+");
  });
});

test("formatCents", () => {
  expect(formatCents(123456)).toBe("$1,234.56");
  expect(formatCents(-5)).toBe("-$0.05");
  expect(formatCents(-0)).toBe("$0.00");
});

test("rationalToCents rounds half away from zero", () => {
  expect(rationalToCents(12345, 100)).toBe(12345);
  expect(rationalToCents(1, 1)).toBe(100);
  expect(rationalToCents(1005, 1000)).toBe(101);
  expect(rationalToCents(-1005, 1000)).toBe(-101);
});

test("centsToInput round-trips through parseCents", () => {
  for (const c of [0, 5, -5, 100, 123456, -123456, 9_999_999_999_99]) {
    expect(parseCents(centsToInput(c))).toBe(c);
  }
  expect(centsToInput(-4510)).toBe("-45.10");
});
