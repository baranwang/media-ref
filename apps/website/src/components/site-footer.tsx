import { RiArrowRightUpLine, RiGithubLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { BrandLogo } from "./brand-logos";

const linkClass =
  "-my-1 py-1 text-muted-foreground transition-colors hover:text-foreground pointer-coarse:-my-2.5 pointer-coarse:py-2.5";

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-card/40">
      <div className="container flex flex-col gap-8 py-10 text-xs md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <Link to="/" aria-label="MediaRef 首页" className="flex w-fit">
            <BrandLogo size="small" />
          </Link>
          <p className="text-muted-foreground">这部剧，在哪儿能看？</p>
        </div>

        <div className="grid grid-cols-2 gap-x-12 gap-y-6 sm:flex sm:gap-16">
          <nav aria-label="页脚导航" className="flex flex-col items-start gap-2.5">
            <span className="font-medium text-foreground">浏览</span>
            <Link to="/" className={linkClass}>
              发现
            </Link>
            <Link to="/wanted" className={linkClass}>
              待贡献
            </Link>
            <Link to="/exploration" className={linkClass}>
              探索动态
            </Link>
          </nav>
          <div className="flex flex-col items-start gap-2.5">
            <span className="font-medium text-foreground">开发者</span>
            <Link to="/api-keys" className={linkClass}>
              API 密钥
            </Link>
            <a
              href="https://github.com/baranwang/media-ref"
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center gap-1 ${linkClass}`}
            >
              <RiGithubLine className="size-3.5" />
              GitHub
              <RiArrowRightUpLine className="size-3" />
            </a>
          </div>
        </div>
      </div>

      <div className="border-t border-border/60">
        <div className="container flex flex-col gap-1.5 py-5 text-2xs leading-5 text-muted-foreground/80 md:flex-row md:justify-between md:gap-6">
          {/* TMDB's API terms require this notice wherever its data is shown. */}
          <p>影视资料来自 TMDB、豆瓣、Bangumi。本产品使用 TMDB API，但未经 TMDB 认可或认证。</p>
          <p className="shrink-0">© {new Date().getFullYear()} MediaRef</p>
        </div>
      </div>
    </footer>
  );
}
