import type { CustomerServiceSetup, Order } from "@office/contracts";
import { BusinessFacts } from "@office/contracts";

/** The sample office's Customer Service setup: the facts and answers an owner would write in the first hour, and a few orders. */
export function sampleCustomerService(asOf: string): { setup: CustomerServiceSetup; orders: Order[] } {
  const day = (n: number) => new Date(Date.parse(`${asOf}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const now = `${asOf}T09:00:00+05:30`;
  const order = (number: string, partyId: string | null, customer: string, phone: string, email: string, items: string, status: Order["status"], placed: number, expected: number | null, tracking: string | null = null): Order => ({
    id: `ord-${number.toLowerCase()}`,
    number,
    partyId,
    customer,
    phone,
    email,
    items,
    status,
    placedOn: day(placed),
    expectedOn: expected === null ? null : day(expected),
    tracking,
    note: "",
    updatedAt: now,
  });
  return {
    setup: {
      facts: BusinessFacts.parse({
        hours: "Monday to Saturday, 9:30 am to 7 pm. Closed on Sundays and public holidays.",
        opensAt: "09:30",
        closesAt: "19:00",
        openDays: [1, 2, 3, 4, 5, 6],
        address: "Plot 14, Bhosari MIDC, Pune 411026. Opposite the Bhosari bus depot.",
        delivery: "Free delivery in Pune and Pimpri-Chinchwad on orders over ₹5,000, usually the next working day. Elsewhere in Maharashtra by transport, 2 to 4 days.",
        returns: "Unopened coils and boxes can be returned within 15 days with the invoice. Cut lengths cannot be returned.",
        payments: "UPI, NEFT, RTGS and cheques. Registered customers get 30 days' credit.",
        humanContact: "Anil on +91 20 2712 4480",
      }),
      answers: [
        { id: "ans-gst-invoice", title: "GST invoice", examples: ["Will I get a GST invoice?", "Do you give GST bill", "I need an invoice with my GSTIN"], answer: "Yes. Every order comes with a GST tax invoice. Send us your GSTIN and billing name before we dispatch and it will be on the invoice.", enabled: true },
        { id: "ans-brands", title: "Brands we stock", examples: ["Which brands do you have?", "Do you sell Polycab wire", "Havells MCB available?"], answer: "We stock Polycab, Havells, Finolex and Legrand, and our own Kaveri range of FR PVC wire. Tell us the size and length and we will confirm the price.", enabled: true },
        { id: "ans-bulk", title: "Bulk and contractor pricing", examples: ["Do you have contractor rates?", "price for bulk order", "rate for 50 coils"], answer: "For bulk and contractor orders we send a quotation the same day. Send the items, sizes and quantities, and the site location.", enabled: true },
        { id: "ans-cut", title: "Cut lengths", examples: ["Can you cut wire to length?", "I need 20 metres only", "do you sell by the metre"], answer: "Yes, we cut armoured cable and flexible wire to length at the counter. Cut lengths cannot be returned.", enabled: false },
      ],
      widget: { enabled: true, key: "wsamplekaverishop01" },
      retentionMonths: 12,
      supportEmail: "kaveri-electricals.help@in.the-office.app",
    },
    orders: [
      order("SO-1042", "C01", "Sharma Traders", "+91 9489305653", "accounts@sharmatraders.in", "20 coils FR PVC wire 1.5 sq mm", "dispatched", -2, 1, "https://track.example.in/VRL/88214"),
      order("SO-1043", "C03", "Deshmukh Contractors", "+91 9851425814", "accounts@deshmukhcontractor.in", "Armoured cable 4 core 16 sq mm, 150 m", "packed", -1, 2),
      order("SO-1039", "C01", "Sharma Traders", "+91 9489305653", "accounts@sharmatraders.in", "12 MCB 32A DP", "delivered", -9, -6),
      order("SO-1045", null, "Priya Nair", "+91 9822011223", "priya.nair@example.com", "2 coils FR PVC wire 2.5 sq mm", "received", 0, 3),
    ],
  };
}

/** Customers writing in over the last few hours, replayed through the agent when the mockup opens. */
export function sampleConversations(now: number): { channel: "whatsapp" | "email" | "web"; key: string; name: string; text: string; at: string; subject?: string }[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return [
    { channel: "whatsapp", key: "919489305653", name: "Rakesh Sharma", text: "Hi, where is my order SO-1042?", at: ago(190) },
    { channel: "whatsapp", key: "919851425814", name: "Vikas Deshmukh", text: "How much do we owe you right now?", at: ago(150) },
    { channel: "web", key: "visitor-sample-0000000001", name: "Website visitor", text: "Do you deliver to Satara? What does it cost?", at: ago(95) },
    { channel: "email", key: "accounts@joshielectricals.in", name: "Mandar Joshi", subject: "Damaged coils in last delivery", text: "Two of the coils in our last delivery were damaged. We want a refund for them.", at: ago(60) },
    { channel: "web", key: "visitor-sample-0000000002", name: "Website visitor", text: "Will I get a GST invoice?", at: ago(12) },
  ];
}
