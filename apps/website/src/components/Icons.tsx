import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function GitHubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" width="18" height="18" {...props}>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

export function TraktIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" {...props}>
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8.4 12.2l2.3 2.3 5-5.2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" {...props}>
      <circle cx="7.5" cy="15.5" r="4.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M11 12l8.5-8.5M16 7l2.5 2.5M18.5 4.5L21 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <path
        d="M5 13l4 4L19 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AlertTriangleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" {...props}>
      <path
        d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4 7l8 6 8-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <path
        d="M21 12a9 9 0 1 1-2.64-6.36L21 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 3v5h-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <path
        d="M3 6h18M8 6V4a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 16 4v2m2 0-1 14a2 2 0 0 1-2 1.85H9A2 2 0 0 1 7 20L6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <path
        d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ShieldCheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" {...props}>
      <path
        d="M12 3l7 3v5c0 4.5-2.9 8.4-7 10-4.1-1.6-7-5.5-7-10V6l7-3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M9 12l2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 11V7a4 4 0 0 1 8 0v4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15" fill="none" {...props}>
      <path
        d="M14 5h5v5M10 14L19 5M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FileCheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" {...props}>
      <path
        d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v5h5M9 15l2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function XCircleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" {...props}>
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
