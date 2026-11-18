import { addDays } from "../dates";
import type { OfficeService } from "../office";
import { layoutKey } from "./formats";
import { SALES_AGENT } from "./service";

/**
 * The demo's online sales: eight weeks of Amazon, Flipkart and Blinkit reports for the sample
 * business's own products, read through the same readers a real report goes through, plus an
 * Amazon settlement and one Zepto sheet in a layout the owner has not confirmed yet.
 */
export function seedSampleSales(office: OfficeService) {
  Object.assign(office.state(SALES_AGENT), { hired: true, trustLevel: "trainee", hiredOn: office.asOf });
  let seed = 20261104;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const skus = office.books.skus.filter((s) => s.pricePaise > 0 && s.pricePaise < 50_000_00).slice(0, 18);
  if (!skus.length) return;
  // Quick commerce carries the small, cheap things.
  const quick = [...skus].sort((a, b) => a.pricePaise - b.pricePaise).slice(0, 6);
  const places = [
    ["Pune", "MAHARASHTRA"],
    ["Mumbai", "MAHARASHTRA"],
    ["Nashik", "MAHARASHTRA"],
    ["Bengaluru", "KARNATAKA"],
    ["Hyderabad", "TELANGANA"],
    ["Ahmedabad", "GUJARAT"],
    ["Delhi", "DELHI"],
    ["Chennai", "TAMIL NADU"],
    ["Indore", "MADHYA PRADESH"],
    ["Goa", "GOA"],
  ] as const;
  const rupees = (p: number) => (p / 100).toFixed(2);
  const gstin = office.books.business.gstin;
  const end = addDays(office.asOf, -1);
  const days = Array.from({ length: 56 }, (_, i) => addDays(end, -55 + i));

  // Amazon: the B2C tax report, with returns a week or two after some sales.
  const amazon: string[][] = [["Seller Gstin", "Invoice Number", "Invoice Date", "Transaction Type", "Order Id", "Shipment Item Id", "Quantity", "Item Description", "Sku", "Ship To City", "Ship To State", "Invoice Amount", "Tax Exclusive Gross", "Total Tax Amount"]];
  const flipkart: string[][] = [["Seller GSTIN", "Order ID", "Order Item ID", "Product Title/Description", "FSN", "SKU", "Event Type", "Order Date", "Item Quantity", "Final Invoice Amount (Price after discount+Shipping Charges)", "Taxable Value (Final Invoice Amount -Taxes)", "Buyer Invoice ID", "Customer's Delivery State"]];
  const blinkit: string[][] = [["Date", "PO Number", "Item Name", "City", "Qty Sold", "GMV"]];
  let n = 0;
  for (const [d, day] of days.entries()) {
    const growth = 1 + d / 80;
    const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()) ? 1.4 : 1;
    for (let i = 0; i < Math.round((3 + rand() * 4) * growth * weekend); i++) {
      const s = pick(skus);
      const qty = rand() < 0.8 ? 1 : 2;
      const [city, state] = pick(places);
      const gross = Math.round((s.pricePaise * qty * (1 + s.gstRate / 100)) / 100) * 100;
      const taxable = Math.round(gross / (1 + s.gstRate / 100));
      const order = `40${3 + (n % 5)}-${String(7_000_000 + n * 37).slice(0, 7)}-${String(1_000_000 + n * 131).slice(0, 7)}`;
      amazon.push([gstin, `IN-${1000 + n}`, `${day} ${String(9 + (n % 10)).padStart(2, "0")}:15:00`, "Shipment", order, `SI${n}`, String(qty), s.name, s.id, city.toUpperCase(), state, rupees(gross), rupees(taxable), rupees(gross - taxable)]);
      // The returns rate differs by product, so one stands out.
      const returns = s === skus[2] ? 0.3 : 0.03;
      const back = addDays(day, 5 + Math.floor(rand() * 9));
      if (rand() < returns && back <= end) amazon.push([gstin, `CN-${1000 + n}`, `${back} 11:00:00`, "Refund", order, `SI${n}`, String(qty), s.name, s.id, city.toUpperCase(), state, `-${rupees(gross)}`, `-${rupees(taxable)}`, `-${rupees(gross - taxable)}`]);
      n++;
    }
    for (let i = 0; i < Math.round((1 + rand() * 3) * weekend); i++) {
      const s = pick(skus);
      const [, state] = pick(places);
      const gross = Math.round((s.pricePaise * (1 + s.gstRate / 100)) / 100) * 100;
      flipkart.push([gstin, `OD${3000 + n}`, `OI${n}`, s.name, `FSN${s.id}`, s.id, rand() < 0.05 ? "Return" : "Sale", day, "1", rupees(gross), rupees(Math.round(gross / (1 + s.gstRate / 100))), `FAX${n}`, state.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())]);
      n++;
    }
    // Quick commerce in three cities, only for the last four weeks.
    if (d >= 28)
      for (const city of ["Mumbai", "Pune", "Bengaluru"]) {
        const s = pick(quick);
        const qty = 1 + Math.floor(rand() * 3);
        blinkit.push([`${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`, `BLK-${day.replace(/-/g, "")}-${city.slice(0, 3).toUpperCase()}`, s.name, city, String(qty), (Math.round((s.pricePaise * qty * 1.18) / 100)).toLocaleString("en-IN")]);
      }
  }
  const sales = office.sales;
  // Blinkit's layout was confirmed once, so its reports are read on their own.
  sales.store.saveMapping(layoutKey(blinkit[0]!), { channel: "blinkit", mapping: { date: "Date", order: "PO Number", item: "Item Name", city: "City", qty: "Qty Sold", gross: "GMV" } });
  sales.receive({ file: "MTR_B2C-last-8-weeks.csv", sheets: [{ name: "MTR_B2C", rows: amazon }], hash: "sample-amazon", via: "email", sender: "no-reply@amazon.in" });
  sales.receive({ file: "Flipkart Sales Report.xlsx", sheets: [{ name: "Sales Report", rows: flipkart }], hash: "sample-flipkart", via: "email", sender: "noreply@flipkart.com" });
  sales.receive({ file: "blinkit_daily_sales.csv", sheets: [{ name: "blinkit", rows: blinkit }], hash: "sample-blinkit", via: "whatsapp", sender: null });
  const start = addDays(end, -13);
  const dot = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} 00:00:00 UTC`;
  sales.receive({
    file: "settlement-report.txt",
    sheets: [
      {
        name: "settlement",
        rows: [
          ["settlement-id", "settlement-start-date", "settlement-end-date", "deposit-date", "total-amount", "currency", "amount-type", "amount-description", "amount"],
          ["1191", dot(start), dot(end), dot(addDays(end, 1)), "184520.40", "INR", "", "", ""],
          ["1191", "", "", "", "", "", "ItemPrice", "Principal", "212400.00"],
          ["1191", "", "", "", "", "", "ItemPrice", "Shipping", "3200.00"],
          ["1191", "", "", "", "", "", "ItemFees", "Commission", "-18410.25"],
          ["1191", "", "", "", "", "", "ItemFees", "FBA Weight Handling Fee", "-7420.00"],
          ["1191", "", "", "", "", "", "ItemWithheldTax", "TCS-IGST", "-1062.00"],
          ["1191", "", "", "", "", "", "Refund", "Principal", "-4187.35"],
        ],
      },
    ],
    hash: "sample-settlement",
    via: "email",
    sender: "no-reply@amazon.in",
  });
  sales.receive({
    file: "zepto_sales_oct.csv",
    sheets: [{ name: "zepto", rows: [["Sale Date", "Ref No", "Product", "Store City", "Units", "Sale Value"], ...days.slice(-6).map((d, i) => [d, `ZP${i}`, skus[i % skus.length]!.name, "Mumbai", "3", "1,770"])] }],
    hash: "sample-zepto",
    via: "email",
    sender: "reports@zeptonow.com",
  });
}
