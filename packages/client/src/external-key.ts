import { isNamespace } from "./types.ts";
import type { ExternalKey } from "./types.ts";

export function parseExternalKey(raw: string): ExternalKey | null {
  const colonIndex = raw.indexOf(":");
  if (colonIndex <= 0) {
    return null;
  }

  const namespace = raw.slice(0, colonIndex);
  if (!isNamespace(namespace)) {
    return null;
  }

  const nativeId = raw.slice(colonIndex + 1);
  if (nativeId.length === 0 || nativeId !== nativeId.trim()) {
    return null;
  }

  return { namespace, nativeId };
}

export function formatExternalKey(key: ExternalKey): string {
  if (!isNamespace(key.namespace)) {
    throw new RangeError(`Unknown namespace: ${String(key.namespace)}`);
  }

  if (
    typeof key.nativeId !== "string" ||
    key.nativeId.length === 0 ||
    key.nativeId !== key.nativeId.trim()
  ) {
    throw new RangeError(`Invalid nativeId for namespace ${key.namespace}`);
  }

  return `${key.namespace}:${key.nativeId}`;
}
