/**
 * Integer-paise arithmetic. Mirrors tools/synthetic/money.py exactly:
 * every rounding is half-up, applied to integers.
 */

export function divHalfUp(numerator: number, denominator: number): number {
  if (numerator < 0) return -divHalfUp(-numerator, denominator);
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

export function lineTaxable(qty: number, ratePaise: number, discountPct: number): number {
  return divHalfUp(qty * ratePaise * (100 - discountPct), 100);
}

/** rateX100 is hundredths of a percent: 9% is 900 */
export function pctOf(amountPaise: number, rateX100: number): number {
  return divHalfUp(amountPaise * rateX100, 10000);
}

export function bpOf(amountPaise: number, basisPoints: number): number {
  return divHalfUp(amountPaise * basisPoints, 10000);
}

export function roundToRupee(paise: number): number {
  return divHalfUp(paise, 100) * 100;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const tail = digits.slice(-3);
  let head = digits.slice(0, -3);
  const groups: string[] = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) groups.unshift(head);
  return `${groups.join(",")},${tail}`;
}

/** 18400000 -> "1,84,000.00"; with { rupees: true } -> "1,84,000" */
export function inr(paise: number, opts: { symbol?: boolean; rupees?: boolean } = {}): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = opts.rupees ? Math.round(abs / 100) : Math.floor(abs / 100);
  let out = groupIndian(String(whole));
  if (!opts.rupees) out += `.${String(abs % 100).padStart(2, "0")}`;
  if (opts.symbol) out = `₹${out}`;
  return negative ? `−${out}` : out;
}

/** Short prose form: ₹18.6 lakh, ₹1.24 crore, ₹42,300 */
export function inrShort(paise: number): string {
  const rupees = paise / 100;
  const sign = rupees < 0 ? "−" : "";
  const a = Math.abs(rupees);
  if (a >= 1_00_00_000) return `${sign}₹${(a / 1_00_00_000).toFixed(2)} crore`;
  if (a >= 1_00_000) return `${sign}₹${(a / 1_00_000).toFixed(1)} lakh`;
  return `${sign}₹${groupIndian(String(Math.round(a)))}`;
}

/** Amount as the GST portal's JSON expects it: rupees with two decimals */
export function r2(paise: number): number {
  return Math.round(paise) / 100;
}

export function fromR2(rupees: number): number {
  return Math.round(rupees * 100);
}
