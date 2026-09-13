import { FC, ReactNode, CSSProperties } from "react";

/**
 * Anticipatory loading placeholders.
 *
 * The rule these follow: a skeleton occupies the same box the real content
 * will occupy, so nothing jumps when the data lands. They are deliberately
 * not spinners -- a spinner says "something is happening somewhere", a
 * skeleton says "four stat tiles and a chart are arriving here".
 *
 * `motion-safe:` gates the pulse, so users who asked the OS for reduced
 * motion still get the layout reservation without the flashing.
 */
export const Skeleton: FC<{ className?: string; style?: CSSProperties; delayMs?: number }> = ({
  className = "",
  style,
  delayMs = 0,
}) => (
  <div
    aria-hidden="true"
    className={`bg-white/[0.07] motion-safe:animate-pulse ${className}`}
    style={{ animationDelay: delayMs ? `${delayMs}ms` : undefined, ...style }}
  />
);

/**
 * A run of text lines. Each line's pulse is offset slightly so the block
 * reads as several lines of text rather than one flashing slab, and the last
 * line is short, the way real wrapped text ends.
 */
export const SkeletonText: FC<{ lines?: number; className?: string }> = ({ lines = 3, className = "" }) => (
  <div className={`flex flex-col gap-2 ${className}`}>
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton
        key={i}
        delayMs={i * 120}
        className="h-[13px]"
        style={i === lines - 1 && lines > 1 ? { width: "62%" } : undefined}
      />
    ))}
  </div>
);

/** The bordered chrome SectionCard uses, with a placeholder body. */
export const SkeletonCard: FC<{ title?: string; children?: ReactNode; className?: string }> = ({
  title,
  children,
  className = "",
}) => (
  <div className={`border border-white/12 p-5 ${className}`}>
    <div className="flex items-center justify-between mb-4">
      {title
        ? <h2 className="text-[13px] uppercase tracking-[0.16em] text-white/40">{title}</h2>
        : <Skeleton className="h-[13px] w-40" />}
    </div>
    {children ?? <SkeletonText lines={3} />}
  </div>
);

/** A row of stat tiles -- the shape at the top of the dashboard. */
export const SkeletonStats: FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="border border-white/12 p-4 flex flex-col gap-3">
        <Skeleton delayMs={i * 90} className="h-[11px] w-24" />
        <Skeleton delayMs={i * 90 + 40} className="h-[28px] w-16" />
        <Skeleton delayMs={i * 90 + 80} className="h-[12px] w-20" />
      </div>
    ))}
  </div>
);

// Deterministic, not random: a re-render must not reshuffle the skeleton,
// which reads as the content changing before it exists.
const BAR_HEIGHTS = [42, 68, 55, 80, 47, 72, 61, 88, 52, 75, 64, 58];

/** Chart placeholder: bars at varied heights, so the box reads as a chart
 *  rather than an empty rectangle. */
export const SkeletonChart: FC<{ height?: number; bars?: number }> = ({ height = 200, bars = 12 }) => (
  <div className="flex items-end gap-2" style={{ height }} aria-hidden="true">
    {Array.from({ length: bars }).map((_, i) => (
      <Skeleton
        key={i}
        delayMs={i * 60}
        className="flex-1"
        style={{ height: `${BAR_HEIGHTS[i % BAR_HEIGHTS.length]}%` }}
      />
    ))}
  </div>
);

/** List placeholder matching the sessions table. */
export const SkeletonRows: FC<{ rows?: number; cols?: number }> = ({ rows = 5, cols = 4 }) => (
  <div className="border border-white/12 divide-y divide-white/10">
    {Array.from({ length: rows }).map((_, r) => (
      <div key={r} className="flex items-center gap-4 px-4 py-3">
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} delayMs={r * 80 + c * 40} className={`h-[13px] ${c === 0 ? "flex-[2]" : "flex-1"}`} />
        ))}
      </div>
    ))}
  </div>
);
