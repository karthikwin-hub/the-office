/**
 * Where an office's files live in R2 and how the app links to them. The office id always
 * comes from the checked membership or the office's own Durable Object, never from a client.
 */
export const officePrefix = (officeId: string) => `o/${officeId}/`;
export const docKey = (officeId: string, id: string) => `${officePrefix(officeId)}docs/${id}`;
export const mediaKey = (officeId: string, id: string) => `${officePrefix(officeId)}media/${id}`;
export const fileUrl = (officeId: string, id: string) => `/api/o/${officeId}/files/${id}`;
export const mediaUrl = (officeId: string, id: string) => `/api/o/${officeId}/social/media/${id}`;
