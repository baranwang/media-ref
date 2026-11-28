// Website-only RPCs (session or reviewer auth). Workspace-only entry: not packed or published.
import { ReviewAlertStatus } from "./gen/mediaref/internal/v1/reviewer_pb.ts";

export * from "./gen/mediaref/internal/v1/account_pb.ts";
export * from "./gen/mediaref/internal/v1/contributor_pb.ts";
export * from "./gen/mediaref/internal/v1/reviewer_pb.ts";

export function toProtoReviewAlertStatus(
  status: "open" | "resolved" | undefined,
): ReviewAlertStatus {
  if (status === "open") {
    return ReviewAlertStatus.OPEN;
  }
  if (status === "resolved") {
    return ReviewAlertStatus.RESOLVED;
  }
  return ReviewAlertStatus.UNSPECIFIED;
}

export function fromProtoReviewAlertStatus(
  status: ReviewAlertStatus,
): "open" | "resolved" | undefined {
  if (status === ReviewAlertStatus.OPEN) {
    return "open";
  }
  if (status === ReviewAlertStatus.RESOLVED) {
    return "resolved";
  }
  return undefined;
}
