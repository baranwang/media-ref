import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
import { Button } from "@media-ref/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@media-ref/ui/components/field";
import { Input } from "@media-ref/ui/components/input";
import {
  RiErrorWarningLine,
  RiFileList3Line,
  RiGithubFill,
  RiKey2Line,
  RiLinksLine,
} from "@remixicon/react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthLayout } from "#/components/auth-layout";
import { NamespaceLogo } from "#/components/brand-logos";
import {
  requestSocialSignInUrl,
  resolveOAuthErrorMessage,
  type SocialOAuthProvider,
} from "#/lib/api-client";
import { useAppStore } from "#/lib/app-store";

interface SignupSearch {
  error?: string;
}

export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): SignupSearch => ({
    error:
      typeof search.error === "string" && search.error.trim().length > 0
        ? search.error.trim()
        : undefined,
  }),
  component: SignupPage,
});

function SignupPage() {
  const search = Route.useSearch();
  const { signUp } = useAppStore();
  const navigate = useNavigate();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(
    search.error ? resolveOAuthErrorMessage(search.error) : null,
  );
  const [oauthLoading, setOauthLoading] = useState<SocialOAuthProvider | null>(null);

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    onSubmit: async ({ value }) => {
      setErrorMessage(null);
      const result = await signUp(value.email, value.password);
      if (!result.ok) {
        setErrorMessage(result.error ?? "注册失败，请稍后重试");
        return;
      }
      void navigate({
        to: "/verify-email",
        search: { email: value.email.trim() },
      });
    },
  });

  const handleOAuth = async (provider: SocialOAuthProvider) => {
    if (oauthLoading) return;
    setErrorMessage(null);
    setOauthError(null);

    setOauthLoading(provider);
    const result = await requestSocialSignInUrl(provider, {
      callbackURL: `${window.location.origin}/`,
      errorCallbackURL: `${window.location.origin}/signup`,
    });
    if (!result.ok) {
      setOauthError(result.error);
      setOauthLoading(null);
      return;
    }
    window.location.assign(result.url);
  };

  const activeError = oauthError ?? errorMessage;

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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOauthError(null);
          void form.handleSubmit();
        }}
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">创建 MediaRef 账号</h1>
          <p className="text-sm text-muted-foreground">用邮箱注册，或者直接用 GitHub、Trakt 账号</p>
        </div>

        {activeError && (
          <Alert variant="destructive" className="px-3 py-2.5">
            <RiErrorWarningLine className="size-4" />
            <AlertTitle>{activeError}</AlertTitle>
            <AlertDescription>
              {oauthError
                ? "你可以重新尝试授权，或改用邮箱创建账号。"
                : "请检查邮箱格式或密码长度后重试。"}
            </AlertDescription>
          </Alert>
        )}

        <FieldGroup>
          <form.Field name="email">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="signup-email">邮箱</FieldLabel>
                <Input
                  id="signup-email"
                  name={field.name}
                  type="email"
                  autoComplete="email"
                  required
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="lin.xiao@example.com"
                  className="h-8"
                />
              </Field>
            )}
          </form.Field>

          <form.Field name="password">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="signup-password">密码</FieldLabel>
                <Input
                  id="signup-password"
                  name={field.name}
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="••••••••••"
                  className="h-8"
                />
                <FieldDescription>至少 8 位</FieldDescription>
              </Field>
            )}
          </form.Field>

          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button
                type="submit"
                variant="default"
                size="lg"
                disabled={isSubmitting}
                className="w-full"
              >
                {isSubmitting ? "创建中…" : "创建账号"}
              </Button>
            )}
          </form.Subscribe>

          <FieldSeparator>或者用这些账号注册</FieldSeparator>

          <div className="grid grid-cols-2 gap-2.5">
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={oauthLoading !== null}
              onClick={() => void handleOAuth("github")}
              className="w-full"
            >
              <RiGithubFill />
              {oauthLoading === "github" ? "正在跳转…" : "GitHub"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={oauthLoading !== null}
              onClick={() => void handleOAuth("trakt")}
              className="w-full"
            >
              <NamespaceLogo namespace="trakt" className="size-4" />
              {oauthLoading === "trakt" ? "正在跳转…" : "Trakt"}
            </Button>
          </div>
        </FieldGroup>

        <div className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
          <p>
            已有账号？{" "}
            <Link
              to="/login"
              className="py-2.5 font-medium text-foreground underline-offset-4 hover:underline"
            >
              登录
            </Link>
          </p>
          <p className="text-2xs text-muted-foreground/80">
            注册即表示你同意
            <span className="mx-0.5 text-muted-foreground underline underline-offset-4">
              服务条款
            </span>
            和
            <span className="mx-0.5 text-muted-foreground underline underline-offset-4">
              隐私说明
            </span>
          </p>
        </div>
      </form>
    </AuthLayout>
  );
}
