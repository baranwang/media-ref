import { Badge } from "@media-ref/ui/components/badge";
import { Button } from "@media-ref/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { NAMESPACE_LABELS, NamespaceLogo } from "#/components/brand-logos";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";

export const Route = createFileRoute("/change-requests/")({
  component: ChangeRequestsListPage,
});

function ChangeRequestsListPage() {
  const { changeRequests, getMediaById } = useAppStore();

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
          <Button variant="outline" nativeButton={false} render={<Link to="/contribute" />}>
            去待贡献列表
          </Button>
        </section>

        <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
          <div className="divide-y divide-border/70">
            {changeRequests.map((cr) => {
              const media = getMediaById(cr.mediaId);
              return (
                <Link
                  key={cr.id}
                  to="/change-requests/$id"
                  params={{ id: cr.id }}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/30"
                >
                  <div className="flex min-w-0 items-center gap-3.5">
                    {media && (
                      <img
                        src={media.posterUrl}
                        alt={media.title}
                        className="h-14 w-9 shrink-0 rounded object-cover ring-1 ring-border/70"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {cr.title}
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
                        <span className="font-mono">#{cr.id}</span>
                      </div>
                    </div>
                  </div>

                  <span className="shrink-0 text-xs text-muted-foreground">{cr.submittedAt}</span>
                </Link>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
