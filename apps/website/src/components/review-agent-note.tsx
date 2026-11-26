import { Avatar, AvatarFallback } from "@media-ref/ui/components/avatar";
import { RiRobot2Line } from "@remixicon/react";
import { formatDateTime, formatEpisodeRange } from "#/lib/format";
import type { ReviewAgentView } from "#/lib/types";

/** The review agent's reasons, opinion and correction, as one reviewer note. */
export function ReviewAgentNote({
  agent,
  time,
  fallback,
}: {
  agent: ReviewAgentView;
  time: string | null;
  /** Shown when the agent left neither reasons nor an opinion. */
  fallback?: string | null;
}) {
  const empty = agent.reasons.length === 0 && !agent.opinion && !agent.correction;
  return (
    <div className="flex items-start gap-3">
      <Avatar size="default">
        <AvatarFallback className="bg-muted text-foreground">
          <RiRobot2Line className="size-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-foreground">审核 agent</span>
          {time && <span className="text-muted-foreground">{formatDateTime(time)}</span>}
        </div>
        {agent.correction && (
          <div className="text-sm leading-6 text-foreground/90">
            <div>改正为第 {agent.correction.season} 季：</div>
            {agent.correction.segments.map((s) => (
              <div key={`${s.season}-${s.start}`} className="font-medium text-foreground">
                第 {s.season} 季 {formatEpisodeRange(s.start, s.end)}
                {s.targetStart !== s.start && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · 平台从第 {s.targetStart} 集起
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {agent.opinion && <p className="text-sm leading-6 text-foreground/90">{agent.opinion}</p>}
        {agent.reasons.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {agent.reasons.map((r) => (
              <li key={r.code} className="text-sm leading-6 text-foreground/90">
                {r.reason}
                <span className="ml-2 font-mono text-2xs text-muted-foreground">{r.code}</span>
              </li>
            ))}
          </ul>
        )}
        {empty && fallback && <p className="text-sm leading-6 text-foreground/90">{fallback}</p>}
      </div>
    </div>
  );
}
