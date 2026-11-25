/** Display formatting shared by pages (Chinese UI). */

export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso);
  const diffSeconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (Number.isNaN(diffSeconds)) return "";
  if (diffSeconds < 60) return "刚刚";
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return formatDate(iso);
}

/** `YYYY-MM-DD` in local time. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD HH:mm` in local time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** "第 1–12 集" / "第 3 集" / "第 5 集起". */
export function formatEpisodeRange(start: number, end: number | null): string {
  if (end === null) return `第 ${start} 集起`;
  return start === end ? `第 ${start} 集` : `第 ${start}–${end} 集`;
}
