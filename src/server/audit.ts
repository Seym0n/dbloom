/** One JSON line per event on stdout. Never pass passwords, tokens or cell values (SEC-TGT-023). */
export function audit(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), audit: event, ...fields }))
}
