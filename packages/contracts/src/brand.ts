/** The product's public name and its maker, wherever a person sees them: pages, emails, exports. */
export const BRAND = {
  name: "Agentic Office",
  maker: "Snilld AI",
  site: "https://snilldai.com",
  contact: "puja@snilldai.com",
} as const;

/**
 * Who keeps a company's books when they are kept here, for its yearly intimation to the ROC under rule 3(6)
 * of the Companies (Accounts) Rules. The bracketed items are filled in with the legal documents before launch.
 */
export const BOOKS_PROVIDER = {
  name: "Snilld AI [legal name]",
  address: "[registered address of Snilld AI]",
  servers: "Cloudflare's network (Durable Objects and R2 storage); the primary copy is not tied to one country",
  backup: "A copy of the books every day on servers in India",
} as const;

/** "Agentic Office by Snilld AI". */
export const BRAND_FULL = `${BRAND.name} by ${BRAND.maker}`;
