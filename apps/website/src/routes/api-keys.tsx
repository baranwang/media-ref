import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
import { Button } from "@media-ref/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@media-ref/ui/components/card";
import { Checkbox } from "@media-ref/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@media-ref/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@media-ref/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@media-ref/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@media-ref/ui/components/field";
import { Input } from "@media-ref/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@media-ref/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@media-ref/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@media-ref/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@media-ref/ui/components/tooltip";
import {
  RiAddLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiEditLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiKey2Line,
  RiMailSendLine,
  RiMoreLine,
  RiShieldKeyholeLine,
} from "@remixicon/react";
import { Skeleton } from "@media-ref/ui/components/skeleton";
import { ConnectError } from "@connectrpc/connect";
import { extractConnectErrorInfo } from "@media-ref/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import { formatCount, formatDate, formatRelativeTime } from "#/lib/format";
import { apiKeyFromProto, usageBarHeights } from "#/lib/mappers";
import { apiKeysQuery, apiUsageQuery, browserClients } from "#/lib/queries";
import type { ApiKeyItem } from "#/lib/types";

export const Route = createFileRoute("/api-keys")({
  component: ApiKeysPage,
});

const apiKeysTableFeatures = tableFeatures({});
const columnHelper = createColumnHelper<typeof apiKeysTableFeatures, ApiKeyItem>();
const NO_KEYS: ApiKeyItem[] = [];
const DAY_SECONDS = 86_400;

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const visible = local.slice(0, Math.min(3, local.length));
  return `${visible}***@${domain}`;
}

function errorMessage(error: unknown): string {
  return extractConnectErrorInfo(ConnectError.from(error)).message || "操作失败，请稍后重试";
}

/** Rounds the chart ceiling up to 1/2/5 × 10ⁿ (at least 10) so the half-way gridline stays round. */
function niceCeiling(n: number): number {
  if (n <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5].map((m) => m * magnitude).find((v) => v >= n) ?? 10 * magnitude;
}

function formatAxis(n: number): string {
  return n >= 1000 ? `${n / 1000}k` : String(n);
}

function ApiKeysPage() {
  const { user, sessionChecked, resendVerificationEmail } = useAppStore();
  const queryClient = useQueryClient();

  const isEmailVerified = user?.emailVerified ?? false;
  const keysQuery = useQuery({ ...apiKeysQuery(), enabled: isEmailVerified });
  const usageQuery = useQuery({ ...apiUsageQuery(), enabled: isEmailVerified });
  const lastUsedMap = useMemo(
    () => new Map(Object.entries(usageQuery.data?.lastUsed ?? {})),
    [usageQuery.data?.lastUsed],
  );
  const apiKeys = useMemo(
    () =>
      keysQuery.data ? keysQuery.data.map((key) => apiKeyFromProto(key, lastUsedMap)) : NO_KEYS,
    [keysQuery.data, lastUsedMap],
  );
  const usage = usageQuery.data?.days ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [canSubmit, setCanSubmit] = useState(false);
  const [expiresOption, setExpiresOption] = useState("90");
  const [creating, setCreating] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<{ name: string; secret: string } | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendError, setResendError] = useState<string | null>(null);

  const [renamingKey, setRenamingKey] = useState<ApiKeyItem | null>(null);
  const [revokingKey, setRevokingKey] = useState<ApiKeyItem | null>(null);
  const [renameInput, setRenameInput] = useState("");

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  const handleResend = async () => {
    if (!user) return;
    setResendError(null);
    const result = await resendVerificationEmail(user.email);
    if (result.ok) {
      setResendCooldown(60);
    } else {
      setResendError(result.error ?? "发送失败，请稍后重试");
    }
  };

  /** Runs a key mutation, then refetches the list; errors land in `actionError`. */
  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await action();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: apiKeysQuery().queryKey }),
          queryClient.invalidateQueries({ queryKey: ["api-usage"] }),
        ]);
        return true;
      } catch (error) {
        setActionError(errorMessage(error));
        return false;
      }
    },
    [queryClient],
  );

  const totalFound = usage.reduce((s, d) => s + d.found, 0);
  const totalNotFound = usage.reduce((s, d) => s + d.notFound, 0);
  const totalSubmitted = usage.reduce((s, d) => s + d.submitted, 0);
  const maxDayTotal = niceCeiling(
    Math.max(0, ...usage.map((d) => d.found + d.notFound + d.submitted)),
  );

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor("name", {
          header: "名称",
          cell: (info) => <span className="font-medium text-foreground">{info.getValue()}</span>,
        }),
        columnHelper.accessor("prefix", {
          header: "前缀",
          cell: (info) => (
            <span className="font-mono text-xs text-muted-foreground">{info.getValue()}</span>
          ),
        }),
        columnHelper.accessor("canSubmit", {
          header: "权限",
          cell: (info) => (
            <span className="text-xs text-muted-foreground">
              {info.getValue() ? "查询媒体、提交变更单" : "查询媒体"}
            </span>
          ),
        }),
        columnHelper.accessor("createdAt", {
          header: "创建时间",
          cell: (info) => (
            <span className="font-mono text-xs text-muted-foreground">
              {formatDate(info.getValue())}
            </span>
          ),
        }),
        columnHelper.accessor("lastUsedAt", {
          header: "最后使用",
          cell: (info) => {
            const lastUsedAt = info.getValue();
            return (
              <span className="text-xs text-muted-foreground">
                {lastUsedAt ? formatRelativeTime(lastUsedAt) : "尚未使用"}
              </span>
            );
          },
        }),
        columnHelper.display({
          id: "actions",
          header: () => null,
          cell: ({ row }) => {
            const item = row.original;
            return (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label={`操作密钥 ${item.name}`} />
                  }
                >
                  <RiMoreLine />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-36">
                  <DropdownMenuItem
                    onClick={() => {
                      setRenamingKey(item);
                      setRenameInput(item.name);
                    }}
                  >
                    <RiEditLine />
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      void runAction(() =>
                        browserClients().account.updateApiKey({
                          id: item.id,
                          canSubmit: !item.canSubmit,
                        }),
                      )
                    }
                  >
                    <RiShieldKeyholeLine />
                    {item.canSubmit ? "仅保留查询权限" : "开启提交变更单"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setRevokingKey(item)}>
                    <RiDeleteBinLine />
                    吊销密钥
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          },
        }),
      ]),
    [runAction],
  );

  const table = useTable({
    features: apiKeysTableFeatures,
    data: apiKeys,
    columns,
  });

  const handleCreate = async () => {
    const name = newName.trim() || "播放器本地客户端";
    setCreating(true);
    const ok = await runAction(async () => {
      const res = await browserClients().account.createApiKey({
        name,
        canSubmit,
        ...(expiresOption === "never" ? {} : { expiresIn: Number(expiresOption) * DAY_SECONDS }),
      });
      setNewlyCreatedKey({ name: res.apiKey?.name ?? name, secret: res.key });
    });
    setCreating(false);
    if (!ok) return;
    setNewName("");
    setCanSubmit(false);
    setExpiresOption("90");
    setCreateOpen(false);
  };

  const handleRename = () => {
    if (!renamingKey) return;
    const id = renamingKey.id;
    setRenamingKey(null);
    void runAction(() => browserClients().account.updateApiKey({ id, name: renameInput.trim() }));
  };

  const handleCopySecret = async () => {
    if (!newlyCreatedKey) return;
    try {
      await navigator.clipboard.writeText(newlyCreatedKey.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback ignored if clipboard blocked
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />

      <main className="container flex flex-col gap-6 pb-20">
        {/* Header */}
        <section className="flex flex-wrap items-end justify-between gap-4 pt-12">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl leading-10 font-bold tracking-tight text-foreground">
              API 密钥
            </h1>
            <p className="text-sm text-muted-foreground">
              让你的播放器、媒体库或脚本用 API 查询媒体、提交变更单。密钥吊销后最多 75 秒内失效。
            </p>
          </div>

          <Button
            variant={isEmailVerified ? "default" : "secondary"}
            size="default"
            disabled={!isEmailVerified}
            onClick={() => {
              setActionError(null);
              setCreateOpen(true);
            }}
            className="px-3.5"
          >
            <RiAddLine />
            创建密钥
          </Button>
        </section>

        {!sessionChecked ? (
          <Skeleton className="h-45 rounded-xl" />
        ) : !user ? (
          <Empty className="rounded-xl border border-border bg-card py-14">
            <EmptyHeader>
              <EmptyTitle>登录后管理 API 密钥</EmptyTitle>
              <EmptyDescription>登录后可以创建、重命名和吊销你的 API 密钥。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="default" nativeButton={false} render={<Link to="/login" />}>
                登录
              </Button>
            </EmptyContent>
          </Empty>
        ) : !isEmailVerified ? (
          /* 05B: Unverified Email Warning */
          <Alert variant="warning" className="p-4">
            <RiErrorWarningLine className="size-4" />
            <AlertTitle className="text-sm font-medium">邮箱还没验证，暂时不能创建密钥</AlertTitle>
            <AlertDescription className="mt-1 flex flex-col gap-3 text-xs">
              <span>
                验证邮件已经发到 {maskEmail(user.email)}
                ，点开邮件里的链接就完成了。验证之前，所有媒体页面照常可以浏览。
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="default"
                  size="default"
                  disabled={resendCooldown > 0}
                  onClick={() => void handleResend()}
                >
                  <RiMailSendLine />
                  {resendCooldown > 0
                    ? `重新发送验证邮件（${resendCooldown} 秒后）`
                    : "重新发送验证邮件"}
                </Button>
                <span className="text-xs text-status-warning-fg/75">
                  {resendError ?? "链接 24 小时内有效。没收到的话，先看看垃圾邮件。"}
                </span>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {actionError && (
              <Alert variant="destructive">
                <RiErrorWarningLine className="size-4" />
                <AlertTitle>{actionError}</AlertTitle>
              </Alert>
            )}

            {/* Newly Created Key Banner (05A) */}
            {newlyCreatedKey && (
              <Alert variant="confirmed" className="p-4">
                <RiKey2Line className="size-4" />
                <AlertTitle className="text-sm font-medium">
                  新密钥「{newlyCreatedKey.name}」已创建
                </AlertTitle>
                <AlertDescription className="mt-1 flex flex-col gap-3 text-xs">
                  <span>
                    完整密钥只显示这一次，关掉这条提示后再也看不到了。请现在复制，保存到你的播放器或脚本里。
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <InputGroup className="h-8 flex-1 rounded-lg border-status-confirmed-border bg-background/80 dark:bg-background/80">
                      <InputGroupInput
                        readOnly
                        value={newlyCreatedKey.secret}
                        aria-label="完整 API 密钥"
                        className="font-mono text-xs text-foreground select-all"
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          size="xs"
                          onClick={() => void handleCopySecret()}
                          aria-label="复制密钥"
                        >
                          {copied ? (
                            <>
                              <RiCheckLine className="size-3.5 text-status-confirmed-fg" />
                              <span className="font-sans text-2xs text-status-confirmed-fg">
                                已复制
                              </span>
                            </>
                          ) : (
                            <RiFileCopyLine className="size-3.5" />
                          )}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                    <Button
                      variant="outline"
                      size="default"
                      onClick={() => setNewlyCreatedKey(null)}
                    >
                      我已保存
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* 14-day API Call Trend Chart (05A) */}
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>API 调用趋势</CardTitle>
                  <CardDescription className="mt-0.5">最近 14 天，所有密钥合计</CardDescription>
                </div>

                <div className="flex flex-wrap items-center gap-5 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-2xs bg-coverage" />
                    <span className="text-muted-foreground">查到媒体</span>
                    <span className="font-mono font-medium text-foreground">
                      {formatCount(totalFound)}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-2xs bg-coverage-muted" />
                    <span className="text-muted-foreground">没查到</span>
                    <span className="font-mono font-medium text-foreground">
                      {formatCount(totalNotFound)}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-2xs bg-muted-foreground/60" />
                    <span className="text-muted-foreground">提交变更单</span>
                    <span className="font-mono font-medium text-foreground">
                      {formatCount(totalSubmitted)}
                    </span>
                  </span>
                </div>
              </CardHeader>

              <CardContent className="pt-2">
                {usageQuery.isPending ? (
                  <Skeleton className="h-45 w-full" />
                ) : usageQuery.isError ? (
                  <Alert variant="destructive">
                    <RiErrorWarningLine className="size-4" />
                    <AlertTitle>调用统计加载失败</AlertTitle>
                    <AlertDescription>{errorMessage(usageQuery.error)}</AlertDescription>
                  </Alert>
                ) : (
                  <div className="relative flex gap-3">
                    {/* Y axis labels */}
                    <div className="flex h-45 w-7 shrink-0 flex-col justify-between pb-6 text-right font-mono text-2xs text-muted-foreground/70">
                      <span>{formatAxis(maxDayTotal)}</span>
                      <span>{formatAxis(maxDayTotal / 2)}</span>
                      <span>0</span>
                    </div>

                    {/* Chart plot */}
                    <div className="relative flex-1">
                      {/* Horizontal gridlines */}
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between"
                      >
                        <div className="border-t border-border/50" />
                        <div className="border-t border-border/50" />
                        <div className="border-t border-border/70" />
                      </div>

                      {/* Bars */}
                      <div className="relative grid h-45 grid-cols-14 items-end gap-2 sm:gap-3">
                        {usage.map((day) => {
                          const { foundPct, notFoundPct, submitPct } = usageBarHeights(
                            day,
                            maxDayTotal,
                          );
                          return (
                            <div
                              key={day.date}
                              className="flex h-full flex-col items-center justify-end gap-2"
                            >
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      aria-label={`${day.date} API 调用统计`}
                                      className="flex h-39 w-full max-w-8 flex-col justify-end overflow-hidden rounded-t-xs transition-opacity hover:opacity-85 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                                    />
                                  }
                                >
                                  <span
                                    style={{ height: `${submitPct}%` }}
                                    className="block w-full bg-muted-foreground/60"
                                  />
                                  <span
                                    style={{ height: `${notFoundPct}%` }}
                                    className="block w-full bg-coverage-muted"
                                  />
                                  <span
                                    style={{ height: `${foundPct}%` }}
                                    className="block w-full bg-coverage"
                                  />
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <div className="flex flex-col gap-0.5 text-xs">
                                    <div className="font-mono font-medium">{day.date}</div>
                                    <div>查到媒体：{formatCount(day.found)}</div>
                                    <div>没查到：{formatCount(day.notFound)}</div>
                                    <div>提交变更单：{formatCount(day.submitted)}</div>
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                              <span className="font-mono text-2xs text-muted-foreground/80">
                                {day.date}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* All Keys Table powered by @tanstack/react-table v9 */}
            <section className="flex flex-col gap-3">
              <div>
                <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                  全部密钥
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  完整密钥只在创建时显示一次，这里只显示开头几位，方便你认出是哪一把。
                </p>
              </div>

              {keysQuery.isPending ? (
                <Skeleton className="h-40 w-full rounded-xl" />
              ) : keysQuery.isError ? (
                <Alert variant="destructive">
                  <RiErrorWarningLine className="size-4" />
                  <AlertTitle>密钥列表加载失败</AlertTitle>
                  <AlertDescription>{errorMessage(keysQuery.error)}</AlertDescription>
                </Alert>
              ) : apiKeys.length === 0 ? (
                <Empty className="rounded-xl border border-border bg-card py-14">
                  <EmptyHeader>
                    <EmptyTitle>还没有创建 API 密钥</EmptyTitle>
                    <EmptyDescription>
                      点击右上角「创建密钥」，生成一把用于播放器或整理脚本的密钥。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <Table>
                    <TableHeader>
                      {table.getHeaderGroups().map((headerGroup) => (
                        <TableRow key={headerGroup.id}>
                          {headerGroup.headers.map((header) => (
                            <TableHead
                              key={header.id}
                              className={
                                header.id === "name"
                                  ? "pl-5"
                                  : header.id === "actions"
                                    ? "w-12 pr-4 text-right"
                                    : undefined
                              }
                            >
                              {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                            </TableHead>
                          ))}
                        </TableRow>
                      ))}
                    </TableHeader>
                    <TableBody>
                      {table.getRowModel().rows.map((row) => (
                        <TableRow key={row.id}>
                          {row.getAllCells().map((cell) => (
                            <TableCell
                              key={cell.id}
                              className={
                                cell.column.id === "name"
                                  ? "pl-5"
                                  : cell.column.id === "actions"
                                    ? "pr-4 text-right"
                                    : undefined
                              }
                            >
                              <table.FlexRender cell={cell} />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* 05C: Create API Key Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>创建 API 密钥</DialogTitle>
            <DialogDescription>给密钥起个名字，方便以后认出它用在哪里。</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-1">
            <Field>
              <FieldLabel htmlFor="key-name">名称</FieldLabel>
              <Input
                id="key-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="播放器本地客户端"
              />
            </Field>

            <Field>
              <FieldLabel>权限</FieldLabel>
              <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-background/50 p-3">
                <Field orientation="horizontal">
                  <Checkbox checked disabled />
                  <FieldContent>
                    <FieldTitle>查询媒体</FieldTitle>
                    <FieldDescription>查媒体在哪个平台、对应第几集</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="perm-submit"
                    checked={canSubmit}
                    onCheckedChange={(checked) => setCanSubmit(Boolean(checked))}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="perm-submit" className="cursor-pointer">
                      提交变更单
                    </FieldLabel>
                    <FieldDescription>让脚本替你提交变更单，补充或修正集数</FieldDescription>
                  </FieldContent>
                </Field>
              </div>
            </Field>

            <Field>
              <FieldLabel>有效期</FieldLabel>
              <Select value={expiresOption} onValueChange={(v) => v && setExpiresOption(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {expiresOption === "never" ? "永不过期" : `${expiresOption} 天`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 天</SelectItem>
                  <SelectItem value="90">90 天</SelectItem>
                  <SelectItem value="365">365 天</SelectItem>
                  <SelectItem value="never">永不过期</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>到期后自动失效，也可以随时提前吊销</FieldDescription>
            </Field>
          </div>

          {actionError && (
            <Alert variant="destructive">
              <RiErrorWarningLine className="size-4" />
              <AlertTitle>{actionError}</AlertTitle>
            </Alert>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="default" disabled={creating} onClick={() => void handleCreate()}>
              {creating ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename API Key Dialog */}
      <Dialog open={Boolean(renamingKey)} onOpenChange={(open) => !open && setRenamingKey(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名密钥</DialogTitle>
            <DialogDescription>更新这把密钥的显示名称，不会影响已部署的调用。</DialogDescription>
          </DialogHeader>
          <Input
            value={renameInput}
            onChange={(e) => setRenameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingKey(null)}>
              取消
            </Button>
            <Button variant="default" onClick={handleRename}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation: revoking is immediate and cannot be undone */}
      <Dialog open={Boolean(revokingKey)} onOpenChange={(open) => !open && setRevokingKey(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>吊销密钥「{revokingKey?.name}」？</DialogTitle>
            <DialogDescription>
              吊销后最多 75 秒内失效，用这把密钥的播放器或脚本会立即无法调用，且无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokingKey(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = revokingKey;
                setRevokingKey(null);
                if (target) {
                  void runAction(() => browserClients().account.deleteApiKey({ id: target.id }));
                }
              }}
            >
              吊销
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
