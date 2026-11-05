import type { CSSProperties, ReactNode } from "react";
export function Icon({
  name,
  size = 18,
  ...props
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const paths: Record<string, ReactNode> = {
    camera: (
      <>
        <rect x="3" y="6" width="12" height="12" rx="3" />
        <path d="m15 10 6-3v10l-6-3" />
      </>
    ),
    mic: (
      <>
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
      </>
    ),
    monitor: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 22h8M12 17v5" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1.5" />
        <path d="m3 17 5-5 4 4 4-6 5 7" />
      </>
    ),
    film: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    play: <path d="m8 4 13 8-13 8Z" />,
    pause: (
      <>
        <path d="M7 4v16M17 4v16" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7a9 9 0 1 0 1 7M20 2v6h-6" />
      </>
    ),
    volume: (
      <>
        <path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" />
      </>
    ),
    maximize: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    people: (
      <>
        <circle cx="9" cy="7" r="4" />
        <path d="M2 21v-3a7 7 0 0 1 14 0v3M16 4a4 4 0 0 1 0 8M22 21v-3a7 7 0 0 0-4-6" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    check: <path d="m4 12 5 5L20 6" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
      </>
    ),
    star: <path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" />,
    left: <path d="m14 7-5 5 5 5" />,
    right: <path d="m10 7 5 5-5 5" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.grid}
    </svg>
  );
}
export function LayoutThumb({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 72 42" aria-hidden="true" className="layout-thumb">
      <rect
        x="1"
        y="1"
        width="70"
        height="40"
        rx="4"
        fill="currentColor"
        opacity=".09"
      />
      {kind === "grid" ? (
        <>
          <rect x="7" y="12" width="27" height="17" rx="2" />
          <rect x="38" y="12" width="27" height="17" rx="2" />
        </>
      ) : kind === "spotlight" ? (
        <rect x="9" y="6" width="54" height="30" rx="2" />
      ) : kind === "side" ? (
        <>
          <rect x="6" y="7" width="44" height="28" rx="2" />
          <rect x="54" y="9" width="12" height="9" rx="1" />
          <rect x="54" y="23" width="12" height="9" rx="1" />
        </>
      ) : kind === "pip" ? (
        <>
          <rect x="6" y="6" width="60" height="30" rx="2" />
          <rect
            x="48"
            y="26"
            width="16"
            height="10"
            rx="1"
            fill="var(--accent)"
          />
        </>
      ) : (
        <rect x="6" y="6" width="60" height="30" rx="2" />
      )}
    </svg>
  );
}
