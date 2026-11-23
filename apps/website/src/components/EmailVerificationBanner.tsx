import { useState } from "react";
import { formatApiError, resendVerificationEmail } from "#/lib/api";
import { AlertTriangleIcon, CheckIcon, MailIcon, RefreshIcon } from "./Icons";

interface EmailVerificationBannerProps {
  email: string;
  onRefreshStatus?: () => Promise<void> | void;
  refreshing?: boolean;
}

export default function EmailVerificationBanner({
  email,
  onRefreshStatus,
  refreshing = false,
}: EmailVerificationBannerProps) {
  const [sending, setSending] = useState(false);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleResend() {
    setSending(true);
    setSentMessage(null);
    setErrorMessage(null);
    try {
      const callbackURL =
        typeof window !== "undefined"
          ? `${window.location.origin}${window.location.pathname || "/keys"}`
          : undefined;
      await resendVerificationEmail(email, callbackURL);
      setSentMessage(`验证邮件已重新发送至 ${email}，请查收收件箱或垃圾邮件文件夹。`);
    } catch (error) {
      setErrorMessage(formatApiError(error, "发送验证邮件失败，请稍后重试"));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      role="alert"
      className="rounded-2xl border border-[var(--warn-border)] bg-[var(--warn-bg)] p-4 sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 text-[var(--warn-ink)]">
            <AlertTriangleIcon />
          </div>
          <div className="space-y-1">
            <h2 className="m-0 text-sm font-bold text-[var(--warn-ink)] sm:text-base">
              请先验证邮箱地址
            </h2>
            <p className="m-0 text-sm leading-relaxed text-[var(--sea-ink)]">
              当前账号邮箱 <code>{email}</code> 尚未验证。完成验证后才能创建接口密钥或提交关联。
            </p>
            {sentMessage ? (
              <p className="m-0 flex items-center gap-1.5 pt-1 text-xs font-semibold text-[var(--ok-ink)]">
                <CheckIcon className="shrink-0" />
                <span>{sentMessage}</span>
              </p>
            ) : null}
            {errorMessage ? (
              <p className="m-0 pt-1 text-xs font-semibold text-[var(--danger-ink)]">
                {errorMessage}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pl-4">
          <button
            type="button"
            onClick={handleResend}
            disabled={sending}
            className="btn-secondary text-xs sm:text-sm"
          >
            <MailIcon className="h-4 w-4" />
            <span>{sending ? "发送中..." : "重新发送验证邮件"}</span>
          </button>
          {onRefreshStatus ? (
            <button
              type="button"
              onClick={() => void onRefreshStatus()}
              disabled={refreshing}
              className="btn-secondary text-xs sm:text-sm"
            >
              <RefreshIcon className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              <span>{refreshing ? "刷新中..." : "刷新验证状态"}</span>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
