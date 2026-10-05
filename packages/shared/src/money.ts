/**
 * Money is stored as integer cents everywhere. Share quantities are stored as
 * integer micro-shares (1e-6). Never do arithmetic on floating-point dollars.
 */

export const SHARE_SCALE = 1_000_000;

/** Parse a user-typed amount like "1,234.56", "-12", "(45.10)" into cents. */
export function parseCents(input: string): number | null {
  let s = input.trim().replace(/[$,\s]/g, "");
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const cents = Number(m[1] || "0") * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return negative ? -cents : cents;
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Format integer cents for display, e.g. 123456 -> "$1,234.56". */
export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  const key = `${locale}|${currency}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
    formatters.set(key, fmt);
  }
  // `|| 0` turns -0 (e.g. from negating a zero total) into 0 so it never shows as "-$0.00".
  return fmt.format(cents / 100 || 0);
}

/** Convert a rational (as stored by GnuCash: num/denom) to integer cents, rounding half away from zero. */
export function rationalToCents(num: number, denom: number): number {
  const v = (num * 100) / denom;
  return Math.sign(v) * Math.round(Math.abs(v));
}

/** Format integer cents as a plain editable number, e.g. -123456 -> "-1234.56". Exact, no floats. */
export function centsToInput(cents: number): string {
  const abs = Math.abs(cents);
  const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${text}` : text;
}
