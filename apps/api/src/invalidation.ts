import { DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD } from "@media-ref/core";

export interface ReportInvalidationResponse {
  reportId: string;
  deduplicated: boolean;
  triggered: boolean;
  jobId: string | null;
  reportCount: number;
  threshold: number;
}

export function parseAnonymousInvalidationThresholdFromEnv(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD;
  }
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD;
}
