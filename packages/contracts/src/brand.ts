/** The product's public name and its maker, wherever a person sees them: pages, emails, exports. */
export const BRAND = {
  name: "Agentic Office",
  maker: "Snilld AI",
  site: "https://snilldai.com",
  contact: "puja@snilldai.com",
} as const;

/** "Agentic Office by Snilld AI". */
export const BRAND_FULL = `${BRAND.name} by ${BRAND.maker}`;
