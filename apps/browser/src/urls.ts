/**
 * Which URLs may be handed to the operating system. Only plain http(s): never file:, a
 * custom-scheme app launcher, javascript:, or a URL with embedded credentials.
 */
export function safeExternalUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  return u.href;
}
