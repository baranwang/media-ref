import { GitHubIcon } from "./Icons";

export default function Footer() {
  return (
    <footer className="mt-16 border-t border-[var(--line)] px-4 py-8 text-[var(--sea-ink-soft)]">
      <div className="page-wrap flex flex-col items-center justify-between gap-3 text-center text-xs sm:flex-row sm:text-left">
        <p className="m-0">
          <strong className="font-semibold text-[var(--sea-ink)]">media-ref</strong> ·
          记录电影与剧集在各视频平台及目录网站上对应编号的开放数据库
        </p>
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/baranwang/media-ref"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[var(--sea-ink-soft)] no-underline transition hover:text-[var(--sea-ink)]"
          >
            <GitHubIcon className="h-4 w-4" />
            <span>GitHub</span>
          </a>
        </div>
      </div>
    </footer>
  );
}
