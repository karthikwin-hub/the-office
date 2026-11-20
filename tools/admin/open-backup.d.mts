/** Types for the API tests, which open a copy the Worker sealed with this tool. */
export function openBackup(secret: string, bytes: Uint8Array | ArrayBuffer): Promise<{ office: string; [k: string]: unknown }>;
