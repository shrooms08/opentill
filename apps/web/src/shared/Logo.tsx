/**
 * OpenTill logo — canonical geometry from the design spec. Do not alter the
 * shapes, the 1.5-unit coin/tray gap, or the color rules. Inline SVG only
 * (~220 bytes of paths); colors come from the CSS tokens.
 */

/** Standard mark, viewBox 0 0 24 24. */
const STD = {
  r: 4,
  cx: 12,
  cy: 5.5,
  tray: "M3 11h3v7h12v-7h3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z",
};

/** Small-size variant (≤16px rendered) — optical compensation only. */
const SMALL = {
  r: 4.5,
  cx: 12,
  cy: 5.5,
  tray: "M2.5 11h3.5v6.5h12V11h3.5v7a3 3 0 0 1-3 3H5.5a3 3 0 0 1-3-3z",
};

export interface LogoMarkProps {
  /** Rendered size in px (square). ≤16 switches to the small-variant paths. */
  size?: number;
  /** Light surface: tray uses --ot-ink instead of --ot-text. Coin stays accent. */
  onLight?: boolean;
  /** Single-color contexts: both shapes take this CSS color (e.g. a var()). */
  singleColor?: string;
}

export function LogoMark({ size = 24, onLight = false, singleColor }: LogoMarkProps) {
  const g = size <= 16 ? SMALL : STD;
  const coin = singleColor ?? "var(--ot-accent)";
  const tray = singleColor ?? (onLight ? "var(--ot-ink)" : "var(--ot-text)");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <circle cx={g.cx} cy={g.cy} r={g.r} fill={coin} />
      <path fillRule="evenodd" d={g.tray} fill={tray} />
    </svg>
  );
}

export interface LogoLockupProps {
  /** Mark height in px. Below the 20px lockup minimum, the mark renders alone. */
  size?: number;
  onLight?: boolean;
}

/**
 * Horizontal lockup: gap = mark-width × 0.32; wordmark cap height ≈ 0.78 ×
 * mark height with its baseline on the tray bottom (tray bottom sits 3/24 of
 * the mark above its box; Space Grotesk cap ≈ 0.7em, descent ≈ 0.2em — the
 * inline styles below encode that math).
 */
export function LogoLockup({ size = 24, onLight = false }: LogoLockupProps) {
  if (size < 20) return <LogoMark size={size} onLight={onLight} />;

  const fontSize = (0.78 * size) / 0.7; // cap height ≈ 0.78 × mark height
  const trayBottom = (3 / 24) * size; // tray bottom offset from mark bottom
  const descent = 0.2 * fontSize; // approx Space Grotesk descender
  return (
    <span
      className="ot-lockup"
      style={{ display: "inline-flex", alignItems: "flex-end", gap: 0.32 * size }}
    >
      <LogoMark size={size} onLight={onLight} />
      <span
        style={{
          font: `700 ${fontSize}px var(--ot-font-display)`,
          letterSpacing: "-0.03em",
          lineHeight: 1,
          color: onLight ? "var(--ot-ink)" : "var(--ot-text)",
          // Baseline (line box bottom − descent) sits on the tray bottom.
          marginBottom: trayBottom - descent,
          whiteSpace: "nowrap",
        }}
      >
        Open<span style={{ color: "var(--ot-accent)" }}>Till</span>
      </span>
    </span>
  );
}
