import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
import { Badge } from "@media-ref/ui/components/badge";
import { Button } from "@media-ref/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@media-ref/ui/components/empty";
import { Skeleton } from "@media-ref/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { NAMESPACE_LABELS, NamespaceLogo } from "#/components/brand-logos";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import { formatDateTime } from "#/lib/format";
import { cardsByKeyQuery, myChangeRequestsQuery } from "#/lib/queries";

export const Route = createFileRoute("/change-requests/")({
  component: ChangeRequestsListPage,
});

function ChangeRequestsListPage() {
  const { user, sessionChecked } = useAppStore();
  const requests = useQuery({ ...myChangeRequestsQuery(), enabled: !!user });
  const changeRequests = requests.data ?? [];
  const { data: cards } = useQuery(cardsByKeyQuery(changeRequests.map((cr) => cr.targetKey)));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />

      <main className="container flex flex-col pb-20">
        <section className="flex flex-wrap items-end justify-between gap-4 pt-12">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl leading-9 font-bold tracking-tight text-foreground">
              我的变更单
            </h1>
            <p className="text-sm text-muted-foreground">
              查看你提交的平台与资料站关联记录、自动核对结果和审核进度。
            </p>
          </div>
          <Button variant="outline" nativeButton={false} render={<Link to="/wanted" />}>
            去待贡献列表
          </Button>
        </section>

        {sessionChecked && !user ? (
          <Empty className="mt-6 rounded-xl border border-border bg-card py-16">
            <EmptyHeader>
              <EmptyTitle>登录后查看你的变更单</EmptyTitle>
              <EmptyDescription>你提交的变更单和审核进度会显示在这里。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to="/login" />}>
                登录
              </Button>
            </EmptyContent>
          </Empty>
        ) : requests.isError ? (
          <Alert variant="destructive" className="mt-6">
            <AlertTitle>变更单加载失败</AlertTitle>
            <AlertDescription>请稍后刷新重试。</AlertDescription>
          </Alert>
        ) : !requests.isSuccess ? (
          <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
            <div className="divide-y divide-border/70">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3.5 px-5 py-4">
                  <Skeleton className="h-14 w-9 shrink-0 rounded" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : changeRequests.length === 0 ? (
          <Empty className="mt-6 rounded-xl border border-border bg-card py-16">
            <EmptyHeader>
              <EmptyTitle>还没有提交过变更单</EmptyTitle>
              <EmptyDescription>去待贡献列表补一条平台记录，提交后会出现在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
            <div className="divide-y divide-border/70">
              {changeRequests.map((cr) => {
                const media = cards?.[cr.targetKey];
                return (
                  <Link
                    key={cr.id}
                    to="/change-requests/$id"
                    params={{ id: cr.id }}
                    className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/30"
                  >
                    <div className="flex min-w-0 items-center gap-3.5">
                      {media?.posterUrl && (
                        <img
                          src={media.posterUrl}
                          alt={media.title}
                          referrerPolicy="no-referrer"
                          className="h-14 w-9 shrink-0 rounded object-cover ring-1 ring-border/70"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {media?.title ?? cr.pageTitle ?? cr.nativeId}
                          </span>
                          <Badge
                            variant={
                              cr.status === "approved"
                                ? "confirmed"
                                : cr.status === "rejected"
                                  ? "destructive"
                                  : "warning"
                            }
                          >
                            {cr.status === "approved"
                              ? "已通过"
                              : cr.status === "rejected"
                                ? "已驳回"
                                : "待审核"}
                          </Badge>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <NamespaceLogo namespace={cr.namespace} className="size-4" />
                          <span>{NAMESPACE_LABELS[cr.namespace]}</span>
                          {cr.variantLabel && <span>· {cr.variantLabel}</span>}
                          <span className="font-mono">#{cr.id.slice(0, 8)}</span>
                        </div>
                      </div>
                    </div>

                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDateTime(cr.createdAt)}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
