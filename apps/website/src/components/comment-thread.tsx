import { Code, ConnectError } from "@connectrpc/connect";
import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
import { Avatar, AvatarFallback } from "@media-ref/ui/components/avatar";
import { Badge } from "@media-ref/ui/components/badge";
import { Button } from "@media-ref/ui/components/button";
import { Skeleton } from "@media-ref/ui/components/skeleton";
import { Textarea } from "@media-ref/ui/components/textarea";
import { RiRobot2Line } from "@remixicon/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatDateTime } from "#/lib/format";
import { commentContent } from "#/lib/mappers";
import { browserClients, changeRequestCommentsQuery, changeRequestQuery } from "#/lib/queries";

/** Same cap as `MAX_COMMENT_LENGTH` in `@media-ref/core`. */
const MAX_COMMENT_LENGTH = 1000;

function sendErrorText(error: Error): string {
  if (error instanceof ConnectError && error.code === Code.ResourceExhausted) {
    return "今天的留言已经到上限了，明天再来。";
  }
  return error.message;
}

/**
 * Writes a comment for the review agent (ADR 0003 amendment 2). 「通过」「驳回」 are shortcuts:
 * they send the note as a comment that starts with 「通过：」 or 「驳回：」.
 */
export function CommentComposer({ changeRequestId }: { changeRequestId: string }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: (shortcut?: "approve" | "reject") =>
      browserClients().contributor.createChangeRequestComment({
        changeRequestId,
        content: commentContent(note, shortcut),
      }),
    onSuccess: async () => {
      setNote("");
      await queryClient.invalidateQueries({
        queryKey: changeRequestCommentsQuery(changeRequestId).queryKey,
      });
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        aria-label="留言"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={MAX_COMMENT_LENGTH}
        placeholder="写下你核实到的情况，比如「第 7 集起错开一位」…"
        rows={3}
      />
      {send.isError && (
        <Alert variant="destructive">
          <AlertTitle>留言没有发出去</AlertTitle>
          <AlertDescription>{sendErrorText(send.error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          审核 agent 会先自己核实，核实得了才照做，并在这里回复
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={send.isPending} onClick={() => send.mutate("reject")}>
            驳回
          </Button>
          <Button
            variant="outline"
            disabled={send.isPending}
            onClick={() => send.mutate("approve")}
          >
            通过
          </Button>
          <Button disabled={send.isPending || !note.trim()} onClick={() => send.mutate(undefined)}>
            留言
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Comments and the review agent's replies, oldest first. */
export function CommentThread({ changeRequestId }: { changeRequestId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery(changeRequestCommentsQuery(changeRequestId));
  const replies = query.data?.filter((c) => c.byAgent).length ?? 0;

  // A new reply means the agent may have changed the request: show its new state.
  useEffect(() => {
    if (replies > 0) {
      void queryClient.invalidateQueries({
        queryKey: changeRequestQuery(changeRequestId).queryKey,
      });
    }
  }, [replies, changeRequestId, queryClient]);

  if (query.isPending) {
    return <Skeleton className="h-20 w-full rounded-lg" />;
  }
  if (query.isError) {
    return <p className="text-sm text-muted-foreground">留言加载失败，请稍后刷新重试。</p>;
  }
  if (query.data.length === 0) {
    return <p className="text-sm text-muted-foreground">还没有留言。</p>;
  }
  return (
    <ol className="flex flex-col gap-5">
      {query.data.map((c) => (
        <li key={c.id} className="flex items-start gap-3">
          <Avatar size="default">
            <AvatarFallback className="bg-muted text-xs font-medium text-foreground">
              {c.byAgent ? <RiRobot2Line className="size-4" /> : c.author.slice(0, 1)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-foreground">{c.author}</span>
              <span className="text-muted-foreground">{formatDateTime(c.createdAt)}</span>
              {c.waiting && <Badge variant="warning">等审核 agent 回复</Badge>}
            </div>
            <p className="mt-1.5 text-sm leading-6 wrap-break-word whitespace-pre-line text-foreground/90">
              {c.content}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
