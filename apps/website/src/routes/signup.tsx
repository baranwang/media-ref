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
import { getApiBaseUrl } from "#/lib/api-client";
import { useAppStore } from "#/lib/app-store";

export const Route = createFileRoute("/signup")({
  component: SignupPage,
});

function SignupPage() {
  const { signUp, signIn } = useAppStore();
  const navigate = useNavigate();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
          void form.handleSubmit();
        }}
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">创建 MediaRef 账号</h1>
          <p className="text-sm text-muted-foreground">用邮箱注册，或者直接用 GitHub、Trakt 账号</p>
        </div>

        {errorMessage && (
          <Alert variant="destructive" className="px-3 py-2.5">
            <RiErrorWarningLine className="size-4" />
            <AlertTitle>{errorMessage}</AlertTitle>
            <AlertDescription>请检查邮箱格式或密码长度后重试。</AlertDescription>
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
            已有账号？{" "}
            <Link
              to="/login"
              className="font-medium text-foreground underline-offset-4 hover:underline"
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
