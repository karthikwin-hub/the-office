/**
 * The figures the product page walks through, taken from the Kaveri Electricals sample books as of
 * 4 November 2026 (packages/fixtures/data/office.json). They are written out so the page does not load the engine.
 */

export const AS_OF = "4 November 2026";

/** Overdue balances by customer: invoices past their due date, less what has been received against them. */
export const OVERDUE: { name: string; invoices: number; oldestDays: number; rupees: number }[] = [
  { name: "Kale Constructions", invoices: 5, oldestDays: 73, rupees: 1919070 },
  { name: "Wagh Power Solutions", invoices: 7, oldestDays: 130, rupees: 1201498 },
  { name: "Shinde Infra Projects", invoices: 2, oldestDays: 22, rupees: 489321 },
  { name: "Sahyog Infratech Ltd", invoices: 4, oldestDays: 71, rupees: 460790 },
  { name: "Apte Hardware", invoices: 2, oldestDays: 193, rupees: 332464 },
  { name: "Urban Nest Interiors Pvt Ltd", invoices: 1, oldestDays: 28, rupees: 277854 },
  { name: "Phadke Home Store", invoices: 1, oldestDays: 104, rupees: 264099 },
  { name: "More Electricals", invoices: 1, oldestDays: 13, rupees: 210408 },
  { name: "Desai Infra", invoices: 1, oldestDays: 52, rupees: 170911 },
  { name: "Deshmukh Contractors", invoices: 2, oldestDays: 44, rupees: 163001 },
  { name: "Joshi Electricals", invoices: 1, oldestDays: 48, rupees: 134343 },
  { name: "Hegde Electricals", invoices: 2, oldestDays: 94, rupees: 124608 },
  { name: "Pawar Electric Works", invoices: 1, oldestDays: 47, rupees: 107398 },
  { name: "Sharma Traders", invoices: 1, oldestDays: 9, rupees: 85930 },
  { name: "Lokhande Industries", invoices: 1, oldestDays: 118, rupees: 44208 },
];
export const OVERDUE_TOTAL = 5985901;
export const FOCUS_CUSTOMER = "Sahyog Infratech Ltd";

export const SAHYOG_INVOICES: { number: string; date: string; daysLate: number; rupees: number }[] = [
  { number: "KE/26-27/0142", date: "11 Jul", daysLate: 71, rupees: 79794 },
  { number: "KE/26-27/0162", date: "27 Jul", daysLate: 55, rupees: 171273 },
  { number: "KE/26-27/0214", date: "7 Sep", daysLate: 13, rupees: 134351 },
  { number: "KE/26-27/0231", date: "19 Sep", daysLate: 1, rupees: 75373 },
];
export const FOCUS_INVOICE = "KE/26-27/0214";

export const INVOICE_0214 = {
  number: "KE/26-27/0214",
  date: "07/09/2026",
  due: "22/10/2026",
  lines: [
    { item: "LED floodlight 100 W", hsn: "9405", qty: "24 nos", rate: "2,350.00", taxable: "55,272.00" },
    { item: "RCCB 4 pole 63 A 30 mA", hsn: "8536", qty: "28 nos", rate: "3,850.00", taxable: "1,05,644.00" },
    { item: "Changeover switch 63 A", hsn: "8536", qty: "9 nos", rate: "2,950.00", taxable: "26,019.00" },
    { item: "MCB single pole 16 A", hsn: "8536", qty: "15 nos", rate: "185.00", taxable: "2,719.50" },
  ],
  taxable: "1,89,654.50",
  cgst: "17,068.91",
  sgst: "17,068.91",
  roundOff: "-0.32",
  total: "2,23,792.00",
  received: "89,441",
  receivedOn: "27 Oct by NEFT",
  balance: "1,34,351",
  words: "Rupees two lakh twenty-three thousand seven hundred ninety-two only",
};

/** Indian digit grouping for whole rupees: 5985901 is 59,85,901. */
export function inr(rupees: number) {
  return Math.round(rupees).toLocaleString("en-IN");
}
