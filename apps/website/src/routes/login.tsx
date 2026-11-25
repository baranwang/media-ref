import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
import { Button } from "@media-ref/ui/components/button";
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "@media-ref/ui/components/field";
import { Input } from "@media-ref/ui/components/input";
import {
  RiCodeSSlashLine,
  RiErrorWarningLine,
  RiGithubFill,
  RiGlobalLine,
  RiTeamLine,
} from "@remixicon/react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthLayout } from "#/components/auth-layout";
import { NamespaceLogo } from "#/components/brand-logos";
import { getApiBaseUrl } from "#/lib/api-client";
import { useAppStore } from "#/lib/app-store";

interface LoginSearch {
  error?: number;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    error: search.error === 1 || search.error === "1" ? 1 : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const { signIn } = useAppStore();
  const navigate = useNavigate();

  const [errorMessage, setErrorMessage] = useState<string | null>(
    search.error === 1 ? "邮箱或密码不对" : null,
  );

  const form = useForm({
    defaultValues: {
      email: search.error === 1 ? "lin.xiao@example.com" : "",
      password: search.error === 1 ? "wrong" : "",
    },
    onSubmit: async ({ value }) => {
      setErrorMessage(null);
      const result = await signIn(value.email, value.password);
      if (!result.ok) {
        setErrorMessage(result.error ?? "邮箱或密码不对");
        return;
      }
      void navigate({ to: "/" });
    },
  });

  const handleOAuth = (provider: "github" | "trakt") => {
    const apiBase = getApiBaseUrl();
    if (apiBase) {
      window.location.href = `${apiBase}/api/auth/sign-in/social?provider=${provider}`;
      return;
    }
    void signIn("lin.xiao@example.com", "oauth-demo-pass").then(() => {
      void navigate({ to: "/" });
    });
  };

  return (
    <AuthLayout
      showcaseTitle="这部剧，在哪儿能看？"
      showcaseDescription="MediaRef 记录每部电影和剧在哔哩哔哩、腾讯视频、爱奇艺、优酷、芒果 TV 上的位置，精确到第几季第几集。"
      showcaseFacts={[
        { icon: <RiGlobalLine />, label: "开源，数据公开" },
        { icon: <RiCodeSSlashLine />, label: "免费 API 查询" },
        { icon: <RiTeamLine />, label: "任何人都能补充" },
      ]}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">登录 MediaRef</h1>
          <p className="text-sm text-muted-foreground">登录后可以补充关联和管理 API 密钥</p>
        </div>

        {/* 06D Error State Alert */}
        {errorMessage && (
          <Alert variant="destructive" className="px-3 py-2.5">
            <RiErrorWarningLine className="size-4" />
            <AlertTitle>{errorMessage}</AlertTitle>
            <AlertDescription>检查一下大小写，或者点「忘记密码？」重设。</AlertDescription>
          </Alert>
        )}

        <FieldGroup>
          <form.Field name="email">
            {(field) => (
              <Field data-invalid={Boolean(errorMessage)}>
                <FieldLabel htmlFor="login-email">邮箱</FieldLabel>
                <Input
                  id="login-email"
                  name={field.name}
                  type="email"
                  autoComplete="email"
                  required
                  aria-invalid={Boolean(errorMessage)}
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
              <Field data-invalid={Boolean(errorMessage)}>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="login-password">密码</FieldLabel>
                  <button
                    type="button"
                    onClick={() =>
                      void navigate({
                        to: "/verify-email",
                        search: { email: form.state.values.email || "lin.xiao@example.com" },
                      })
                    }
                    className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                  >
                    忘记密码？
                  </button>
                </div>
                <Input
                  id="login-password"
                  name={field.name}
                  type="password"
                  autoComplete="current-password"
                  required
                  aria-invalid={Boolean(errorMessage)}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="••••••••••"
                  className="h-8"
                />
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
                {isSubmitting ? "登录中…" : "登录"}
              </Button>
            )}
          </form.Subscribe>

          <FieldSeparator>或者用这些账号登录</FieldSeparator>

          <div className="grid grid-cols-2 gap-2.5">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => handleOAuth("github")}
              className="w-full"
            >
              <RiGithubFill />
              GitHub
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => handleOAuth("trakt")}
              className="w-full"
            >
              <NamespaceLogo namespace="trakt" className="size-4" />
              Trakt
            </Button>
          </div>
        </FieldGroup>

        <div className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
          <p>
            还没有账号？{" "}
            <Link
              to="/signup"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              注册
            </Link>
          </p>
          <p className="text-2xs text-muted-foreground/80">
            继续即表示你同意
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
