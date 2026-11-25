import { Button } from "@media-ref/ui/components/button";
import {
  RiArrowRightUpLine,
  RiFileList3Line,
  RiKey2Line,
  RiLinksLine,
  RiMailCheckLine,
} from "@remixicon/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthLayout } from "#/components/auth-layout";
import { useAppStore } from "#/lib/app-store";
import { detectWebmailProvider } from "#/lib/url-parser";

interface VerifyEmailSearch {
  email?: string;
}

export const Route = createFileRoute("/verify-email")({
  validateSearch: (search: Record<string, unknown>): VerifyEmailSearch => ({
    email:
      typeof search.email === "string" && search.email.trim() ? search.email.trim() : undefined,
  }),
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const search = Route.useSearch();
  const { user, resendVerificationEmail } = useAppStore();
  const targetEmail = search.email ?? user?.email ?? "";
  const webmail = detectWebmailProvider(targetEmail);

  // The email was just sent on sign-up, so start with the resend cooldown running.
  const [countdown, setCountdown] = useState(60);
  const [resendError, setResendError] = useState<string | null>(null);

  const handleResend = async () => {
    setResendError(null);
    const result = await resendVerificationEmail(targetEmail);
    if (result.ok) {
      setCountdown(60);
    } else {
      setResendError(result.error ?? "发送失败，请稍后重试");
    }
  };

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  return (
    <AuthLayout
      showcaseTitle="知道在哪能看？补上它。"
      showcaseDescription="贴一个播放页网址，标出对应第几季第几集。审核通过后所有人都能查到。"
      showcaseFacts={[
        { icon: <RiLinksLine />, label: "补充平台关联" },
        { icon: <RiFileList3Line />, label: "跟踪你的变更单" },
        { icon: <RiKey2Line />, label: "申请 API 密钥" },
      ]}
    >
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-foreground">
          <RiMailCheckLine className="size-5" />
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">查看你的邮箱</h1>
          <p className="text-xs leading-5 text-muted-foreground">
            确认邮件已经发到 <span className="font-mono text-foreground">{targetEmail}</span>
            ，点邮件里的链接就能完成注册。
          </p>
        </div>

        <div className="flex w-full flex-col gap-2.5">
          <Button
            variant="default"
            size="lg"
            className="w-full"
            nativeButton={false}
            render={<a href={webmail.url} target="_blank" rel="noreferrer" />}
          >
            {webmail.label}
            <RiArrowRightUpLine />
          </Button>

          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={countdown > 0 || !targetEmail}
            onClick={() => void handleResend()}
            className="w-full"
          >
            {countdown > 0 ? `重新发送（${countdown} 秒后）` : "重新发送验证邮件"}
          </Button>
        </div>

        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          <p className={resendError ? "text-destructive" : undefined}>
            {resendError ?? "没收到的话，先看看垃圾邮件"}
          </p>
          <p>
            邮箱填错了？{" "}
            <Link
              to="/signup"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              换个邮箱
            </Link>
          </p>
        </div>
      </div>
    </AuthLayout>
  );
}
