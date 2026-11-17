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

type Rational = { n: bigint; d: bigint };

function toRational(text: string): Rational | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const frac = m[2] ?? "";
  return { n: BigInt((m[1] || "0") + frac), d: 10n ** BigInt(frac.length) };
}

/**
 * Like parseCents, but also accepts arithmetic such as "45.10+12.99", "120/3" or "100*0.0825".
 * Supports + - * / (and × ÷) with the usual precedence and a leading minus; parentheses keep
 * meaning "negative" as in parseCents. Exact rational math, rounded once to cents half away from zero.
 */
export function evaluateCents(input: string): number | null {
  const plain = parseCents(input);
  if (plain !== null) return plain;
  const s = input.replace(/[$,\s]/g, "").replace(/×/g, "*").replace(/÷/g, "/");
  const parts = s.split(/([+\-*/])/);
  // parts alternates operand, operator, operand...; a leading "-" or "+" leaves an empty first operand.
  let i = 0;
  let sign = 1n;
  if (parts[0] === "" && (parts[1] === "-" || parts[1] === "+")) {
    if (parts[1] === "-") sign = -1n;
    i = 2;
  }
  const first = toRational(parts[i] ?? "");
  if (!first) return null;
  let term: Rational = { n: first.n * sign, d: first.d };
  let total: Rational = { n: 0n, d: 1n };
  for (i += 1; i < parts.length; i += 2) {
    const op = parts[i]!;
    const v = toRational(parts[i + 1] ?? "");
    if (!v) return null;
    if (op === "*") term = { n: term.n * v.n, d: term.d * v.d };
    else if (op === "/") {
      if (v.n === 0n) return null;
      term = { n: term.n * v.d, d: term.d * v.n };
    } else {
      total = { n: total.n * term.d + term.n * total.d, d: total.d * term.d };
      term = { n: op === "-" ? -v.n : v.n, d: v.d };
    }
  }
  total = { n: total.n * term.d + term.n * total.d, d: total.d * term.d };
  if (total.d < 0n) total = { n: -total.n, d: -total.d };
  const negative = total.n < 0n;
  const abs = negative ? -total.n : total.n;
  const cents = (abs * 200n + total.d) / (2n * total.d);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return negative ? -Number(cents) : Number(cents);
}

/** If the text is an arithmetic expression that evaluates, the result as editable text; otherwise the text unchanged. */
export function settleAmountText(text: string): string {
  if (parseCents(text) !== null) return text;
  const cents = evaluateCents(text);
  return cents === null ? text : centsToInput(cents);
}

const formatters = new Map<string, Intl.NumberFormat>();

let displayCurrency = "USD";

/** Set the currency amounts are shown in (the household's setting). Display only; nothing is converted. */
export function setDisplayCurrency(code: string) {
  displayCurrency = code;
}

export function getDisplayCurrency() {
  return displayCurrency;
}

/** Format integer cents for display, e.g. 123456 -> "$1,234.56". */
export function formatCents(cents: number, currency = displayCurrency, locale = "en-US"): string {
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
