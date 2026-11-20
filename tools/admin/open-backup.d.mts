/** Types for the API tests, which open a copy the Worker sealed with this tool. */
export function openBackup(secrets: string | string[], bytes: Uint8Array | ArrayBuffer): Promise<{ office: string; [k: string]: unknown }>;
export function rootKeys(vars: { SOCIAL_TOKEN_KEY?: string; SOCIAL_TOKEN_KEYS_OLD?: string }): string[];
