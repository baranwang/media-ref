import { Badge } from "@media-ref/ui/components/badge";
import { RiCheckboxCircleLine, RiCloseCircleLine, RiErrorWarningLine } from "@remixicon/react";
import type { AutoCheckItem } from "#/lib/types";

export function CheckItemRow({
  item,
  showBadge = true,
}: {
  item: AutoCheckItem;
  showBadge?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-2.5">
        {item.status === "passed" && (
          <RiCheckboxCircleLine className="mt-0.5 size-4 shrink-0 text-status-confirmed-fg" />
        )}
        {item.status === "failed" && (
          <RiCloseCircleLine className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        {item.status === "needs_confirm" && (
          <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-status-warning-fg" />
        )}
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{item.title}</div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{item.detail}</p>
        </div>
      </div>

      {showBadge && (
        <Badge
          variant={
            item.status === "passed"
              ? "confirmed"
              : item.status === "failed"
                ? "destructive"
                : "warning"
          }
          className="mt-0.5 shrink-0"
        >
          {item.status === "passed" ? "通过" : item.status === "failed" ? "未通过" : "需要人工确认"}
        </Badge>
      )}
    </div>
  );
}
