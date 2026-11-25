// Minimal typing for the workerd built-in module used by server-only code.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
  export function waitUntil(promise: Promise<unknown>): void;
}
