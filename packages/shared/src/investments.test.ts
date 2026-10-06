import { expect, test } from "bun:test";
import {
  parsePrice,
  parseShares,
  priceFromValue,
  priceToString,
  sharesToString,
  sharesValueCents,
} from "./investments";

test("parseShares and sharesToString", () => {
  expect(parseShares("12.5")).toBe(12_500_000);
  expect(parseShares("1,000")).toBe(1_000_000_000);
  expect(parseShares("0.000001")).toBe(1);
  expect(parseShares(".25")).toBe(250_000);
  expect(parseShares("1.2345678")).toBeNull();
  expect(parseShares("-1")).toBeNull();
  expect(parseShares("abc")).toBeNull();
  expect(sharesToString(12_500_000)).toBe("12.5");
  expect(sharesToString(3_000_000)).toBe("3");
  expect(sharesToString(-1)).toBe("-0.000001");
});

test("prices keep at least two decimals", () => {
  expect(parsePrice("$380.27")).toBe(380_270_000);
  expect(priceToString(380_270_000)).toBe("380.27");
  expect(priceToString(200_000_000)).toBe("200.00");
  expect(priceToString(12_345_600)).toBe("12.3456");
});

test("sharesValueCents is exact and rounds half away from zero", () => {
  expect(sharesValueCents(5_000_000, 200_000_000)).toBe(100_000); // 5 × $200
  expect(sharesValueCents(1_500_000, 33_333_333)).toBe(5000); // 1.5 × $33.333333 = $49.9999995
  expect(sharesValueCents(-2_000_000, 325_000_000)).toBe(-65_000);
  expect(sharesValueCents(1, 5_000_000)).toBe(0);
  // Large holdings don't lose precision: 1,000,000 shares at $4,321.123456.
  expect(sharesValueCents(1_000_000_000_000, 4_321_123_456)).toBe(432_112_345_600);
});

test("priceFromValue", () => {
  expect(priceFromValue(100_000, 5_000_000)).toBe(200_000_000);
  expect(priceFromValue(-65_000, -2_000_000)).toBe(325_000_000);
  expect(priceFromValue(100, 3_000_000)).toBe(333_333);
  expect(priceFromValue(100, 0)).toBe(0);
});
