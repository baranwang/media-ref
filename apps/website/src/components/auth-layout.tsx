import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { trendingQuery } from "#/lib/queries";
import { BrandLogo } from "./brand-logos";

const COLLAGE_COLUMNS = 7;
const COLLAGE_ROWS = 6;

interface AuthLayoutProps {
  children: ReactNode;
  showcaseTitle: string;
  showcaseDescription: string;
  showcaseFacts: Array<{ icon: ReactNode; label: string }>;
}

export function AuthLayout({
  children,
  showcaseTitle,
  showcaseDescription,
  showcaseFacts,
}: AuthLayoutProps) {
  const { data } = useQuery(trendingQuery("tmdb", "all", 20));
  const posters = (data ?? []).flatMap((card) => (card.posterUrl ? [card.posterUrl] : []));

  return (
    <div className="grid min-h-svh w-full bg-background lg:grid-cols-2">
      {/* Left column: Brand + centered form */}
      <div className="flex flex-col p-6 md:p-10">
        <div className="flex items-center">
          <Link to="/" className="flex transition-opacity hover:opacity-90">
            <BrandLogo />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-xs">{children}</div>
        </div>
      </div>

      {/* Right column: Full-bleed tilted dark poster collage + display headline */}
      <div className="relative hidden overflow-hidden border-l border-border/60 bg-muted lg:flex lg:flex-col">
        {/* 7 staggered columns x 6 rows, matching the Figma "Poster Wall"; posters repeat to fill it */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-64 flex scale-110 -rotate-12 gap-4 opacity-30 brightness-60"
        >
          {Array.from({ length: COLLAGE_COLUMNS }, (_, col) => (
            <div key={col} className={`flex flex-1 flex-col gap-4 ${col % 2 === 0 ? "pt-28" : ""}`}>
              {Array.from({ length: COLLAGE_ROWS }, (_, row) => (
                <div key={row} className="aspect-2/3 overflow-hidden rounded-lg bg-card">
                  {posters.length > 0 && (
                    <img
                      src={posters[(row * COLLAGE_COLUMNS + col) % posters.length]}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Gradient veil matching Figma dark showcase */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-t from-background via-background/75 to-background/30"
        />

        <div className="relative z-10 mt-auto flex flex-col gap-7 p-14">
          <div className="flex flex-col gap-3">
            <h2 className="font-display text-4xl leading-tight font-bold tracking-tight text-foreground">
              {showcaseTitle}
            </h2>
            <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              {showcaseDescription}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-6 text-xs text-muted-foreground">
            {showcaseFacts.map((fact) => (
              <span key={fact.label} className="inline-flex items-center gap-1.5">
                <span className="text-muted-foreground/80 [&_svg]:size-3.5">{fact.icon}</span>
                {fact.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
