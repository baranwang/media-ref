import { Button } from "@media-ref/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@media-ref/ui/components/dropdown-menu";
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiFileCopyLine,
  RiGithubFill,
  RiMarkdownLine,
} from "@remixicon/react";
import { useState, type ComponentType } from "react";
import { DOCS_SITE_URL } from "#/lib/docs-source";

const REPO_CONTENT_URL =
  "https://github.com/baranwang/media-ref/blob/main/apps/website/content/docs";

const LOBE_ICONS = "https://fastly.jsdelivr.net/npm/@lobehub/icons-static-svg@1.106.0/icons";

/** A lobe-icons logo drawn in the current text color (the SVGs are single-color). */
function lobeIcon(name: string): ComponentType {
  return function LobeIcon() {
    return (
      <span
        aria-hidden
        className="size-3.5 shrink-0 bg-current"
        style={{
          maskImage: `url(${LOBE_ICONS}/${name}.svg)`,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
        }}
      />
    );
  };
}

const OpenAIIcon = lobeIcon("openai");
const ClaudeIcon = lobeIcon("claude");
const GeminiIcon = lobeIcon("gemini");
const GrokIcon = lobeIcon("grok");

/** Copy the page as Markdown, or open it in an AI app. */
export function PageActions({ url, path }: { url: string; path: string }) {
  const markdownUrl = `${url}.md`;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      // A promise in ClipboardItem keeps Safari's user-gesture check happy while the file loads.
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": fetch(markdownUrl).then(async (res) => {
            if (!res.ok) throw new Error(`${markdownUrl}: ${res.status}`);
            return res.blob();
          }),
        }),
      ]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked or the file failed to load; nothing else to do.
    }
  };

  const prompt = `阅读 ${DOCS_SITE_URL}${markdownUrl}，我想问一些关于它的问题。`;
  const apps = [
    {
      label: "用 ChatGPT 打开",
      icon: OpenAIIcon,
      href: `https://chatgpt.com/?${new URLSearchParams({ prompt, hints: "search" })}`,
    },
    {
      label: "用 Claude 打开",
      icon: ClaudeIcon,
      href: `https://claude.ai/new?${new URLSearchParams({ q: prompt })}`,
    },
    {
      label: "用 Gemini 打开",
      icon: GeminiIcon,
      href: `https://gemini.google.com/app?${new URLSearchParams({ prompt })}`,
    },
    {
      label: "用 Grok 打开",
      icon: GrokIcon,
      href: `https://grok.com/?${new URLSearchParams({ q: prompt })}`,
    },
  ];

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => void copy()}>
        {copied ? <RiCheckLine /> : <RiFileCopyLine />}
        {copied ? "已复制" : "复制 Markdown"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          用 AI 打开
          <RiArrowDownSLine />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuItem render={<a href={markdownUrl} target="_blank" rel="noreferrer" />}>
            <RiMarkdownLine />
            查看 Markdown
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<a href={`${REPO_CONTENT_URL}/${path}`} target="_blank" rel="noreferrer" />}
          >
            <RiGithubFill />
            在 GitHub 上查看
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {apps.map(({ label, icon: Icon, href }) => (
            <DropdownMenuItem
              key={label}
              render={<a href={href} target="_blank" rel="noreferrer" />}
            >
              <Icon />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
