/** Recorded voice notes for the demo phone, with what Whisper and the text model made of them. */
export const SAMPLE_VOICE = [
  { id: "owes-hi", label: "Hindi: who owes the most?", transcript: "सबसे ज़्यादा बकाया किस पर है?", language: "hi", kind: "question", english: "Who owes me the most?", party: null },
  { id: "tempo-mr", label: "Marathi: paid for the tempo", transcript: "टेम्पोचे २,४०० दिले", language: "mr", kind: "expense", english: "Paid 2,400 for the tempo", party: "Tempo driver" },
  { id: "bill-en", label: "English: bill a customer", transcript: "Bill Mehta Associates 20 MCB 32 amp at 180", language: "en", kind: "invoice", english: "Bill Mehta Associates 20 MCB 32 amp at 180", party: "Mehta Associates" },
  { id: "quote-hi", label: "Hindi: a quotation", transcript: "साई कृपा बिल्डर्स के लिए 40 LED पैनल का कोटेशन बनाओ", language: "hi", kind: "quote", english: "Make a quotation for 40 LED panels for Sai Krupa Builders", party: "Sai Krupa Builders" },
] as const;
