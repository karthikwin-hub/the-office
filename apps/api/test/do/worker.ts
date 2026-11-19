/** The Worker the Office tests run in: only the Durable Object; tests reach it through its namespace, as the real Worker does. */
export { Office } from "../../src/office-agent";

export default { fetch: () => new Response("Not found", { status: 404 }) } satisfies ExportedHandler;
