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

/** Longest expression evaluateCents will look at; anything longer is rejected rather than evaluated. */
const MAX_EXPRESSION_LENGTH = 100;

/** One operand as a person types it: optional "$", digits with commas only between groups of three, optional decimals. */
const OPERAND = /^\$?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/;

function toRational(text: string): Rational | null {
  const m = OPERAND.exec(text.trim());
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const frac = m[2] ?? "";
  return { n: BigInt(m[1]!.replace(/,/g, "") + frac || "0"), d: 10n ** BigInt(frac.length) };
}

function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reduce(r: Rational): Rational {
  const g = gcd(r.n, r.d) || 1n;
  const sign = r.d < 0n ? -1n : 1n;
  return { n: (sign * r.n) / g, d: (sign * r.d) / g };
}

/** Split into operands and operators; a leading "+" or "-" is a sign, not an operator. */
function tokenize(input: string) {
  const s = input.replace(/×/g, "*").replace(/÷/g, "/").trim();
  const m = /^([+-]?)(.*)$/s.exec(s)!;
  const parts = m[2]!.split(/([+\-*/])/);
  return { negative: m[1] === "-", parts };
}

/** True when the text has an operator between operands, like "10-3" (not just a sign, like "-3"). */
export function isAmountExpression(input: string): boolean {
  return tokenize(input).parts.length > 1;
}

/**
 * Like parseCents, but also accepts arithmetic such as "45.10+12.99", "120/3" or "100*0.0825".
 * Supports + - * / (and × ÷) with the usual precedence and a leading minus; parentheses keep
 * meaning "negative" as in parseCents. Text without an operator is parsed by parseCents alone, so
 * "1.234" is still rejected. Exact rational math, rounded once to cents half away from zero.
 */
export function evaluateCents(input: string): number | null {
  const plain = parseCents(input);
  if (plain !== null) return plain;
  if (input.length > MAX_EXPRESSION_LENGTH) return null;
  const { negative: lead, parts } = tokenize(input);
  if (parts.length < 3) return null;
  const first = toRational(parts[0]!);
  if (!first) return null;
  let term: Rational = { n: lead ? -first.n : first.n, d: first.d };
  let total: Rational = { n: 0n, d: 1n };
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i]!;
    const v = toRational(parts[i + 1] ?? "");
    if (!v) return null;
    if (op === "*") term = reduce({ n: term.n * v.n, d: term.d * v.d });
    else if (op === "/") {
      if (v.n === 0n) return null;
      term = reduce({ n: term.n * v.d, d: term.d * v.n });
    } else {
      total = reduce({ n: total.n * term.d + term.n * total.d, d: total.d * term.d });
      term = { n: op === "-" ? -v.n : v.n, d: v.d };
    }
  }
  total = reduce({ n: total.n * term.d + term.n * total.d, d: total.d * term.d });
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
