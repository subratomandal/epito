'use client';

import { useEffect, useState, useCallback } from 'react';

/**
 * Branded splash animation for Epito.
 *
 * Sequence (2s total):
 *   0-800ms:   Abstract dots emerge from center in orbital paths
 *   800-1400ms: Dots converge and morph into "E" lettermark
 *   1400-1800ms: "pito" characters write in beside the E
 *   1800-2000ms: Subtle glow pulse, then fade out
 *
 * Features:
 *   - Theme-aware (reads CSS variables, no hardcoded colors)
 *   - prefers-reduced-motion: skips immediately
 *   - Click/tap to skip
 *   - Only plays once per session
 *   - onComplete callback for app readiness
 */

interface Props {
  direction: 'in' | 'out';
  onComplete: () => void;
}

export default function BrandedSplash({ direction, onComplete }: Props) {
  const [phase, setPhase] = useState(0); // 0=dots, 1=converge, 2=text, 3=glow, 4=done
  const [skipped, setSkipped] = useState(false);

  const finish = useCallback(() => {
    setSkipped(true);
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    // Respect prefers-reduced-motion
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }

    const isOut = direction === 'out';
    const timings = isOut ? [200, 500, 800, 1000] : [800, 1400, 1800, 2000];

    const t1 = setTimeout(() => setPhase(1), timings[0]);
    const t2 = setTimeout(() => setPhase(2), timings[1]);
    const t3 = setTimeout(() => setPhase(3), timings[2]);
    const t4 = setTimeout(finish, timings[3]);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, [direction, finish]);

  if (skipped) return null;

  const isOut = direction === 'out';

  return (
    <div
      className="splash-container"
      onClick={finish}
      role="button"
      tabIndex={-1}
      aria-label="Skip animation"
    >
      <style>{`
        .splash-container {
          position: fixed;
          inset: 0;
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
          background: hsl(var(--background));
          cursor: pointer;
          overflow: hidden;
          opacity: ${isOut && phase >= 3 ? 0 : 1};
          transition: opacity 0.3s ease;
        }

        .splash-inner {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 300px;
          height: 80px;
        }

        /* ─── Orbital Dots ─── */
        .dot {
          position: absolute;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: hsl(var(--primary));
          opacity: 0;
        }

        .phase-0 .dot {
          animation: dot-emerge 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .phase-0 .dot:nth-child(1) { animation-delay: 0s; }
        .phase-0 .dot:nth-child(2) { animation-delay: 0.08s; }
        .phase-0 .dot:nth-child(3) { animation-delay: 0.16s; }
        .phase-0 .dot:nth-child(4) { animation-delay: 0.24s; }
        .phase-0 .dot:nth-child(5) { animation-delay: 0.32s; }
        .phase-0 .dot:nth-child(6) { animation-delay: 0.4s; }

        .phase-0 .dot:nth-child(1) { --dx: -40px; --dy: -20px; }
        .phase-0 .dot:nth-child(2) { --dx: 35px; --dy: -25px; }
        .phase-0 .dot:nth-child(3) { --dx: -30px; --dy: 22px; }
        .phase-0 .dot:nth-child(4) { --dx: 45px; --dy: 15px; }
        .phase-0 .dot:nth-child(5) { --dx: -15px; --dy: -35px; }
        .phase-0 .dot:nth-child(6) { --dx: 20px; --dy: 30px; }

        @keyframes dot-emerge {
          0% { opacity: 0; transform: translate(0, 0) scale(0); }
          50% { opacity: 1; transform: translate(var(--dx), var(--dy)) scale(1.2); }
          100% { opacity: 0.8; transform: translate(calc(var(--dx) * 0.7), calc(var(--dy) * 0.7)) scale(0.8); }
        }

        /* ─── Converge to E ─── */
        .phase-1 .dot {
          animation: dot-converge 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
          opacity: 0.8;
        }
        @keyframes dot-converge {
          to { opacity: 0; transform: translate(-60px, 0) scale(0.3); }
        }

        .lettermark {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          font-size: 44px;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: hsl(var(--foreground));
          opacity: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
          white-space: nowrap;
          user-select: none;
        }

        .phase-1 .letter-e {
          animation: e-appear 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.2s forwards;
        }

        @keyframes e-appear {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.7); }
          to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }

        /* ─── Text Write-in ─── */
        .letter-rest {
          position: absolute;
          left: calc(50% + 12px);
          top: 50%;
          transform: translateY(-50%);
          font-size: 44px;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: hsl(var(--foreground));
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
          user-select: none;
          display: flex;
          gap: 0px;
        }

        .letter-rest span {
          opacity: 0;
          display: inline-block;
        }

        .phase-2 .letter-rest span {
          animation: char-write 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .phase-2 .letter-rest span:nth-child(1) { animation-delay: 0s; }
        .phase-2 .letter-rest span:nth-child(2) { animation-delay: 0.06s; }
        .phase-2 .letter-rest span:nth-child(3) { animation-delay: 0.12s; }
        .phase-2 .letter-rest span:nth-child(4) { animation-delay: 0.18s; }

        @keyframes char-write {
          from { opacity: 0; transform: translateX(-4px); }
          to { opacity: 1; transform: translateX(0); }
        }

        /* ─── Glow + Fade ─── */
        .phase-3 .lettermark,
        .phase-3 .letter-rest span {
          opacity: 1;
        }
        .phase-3 .splash-inner {
          animation: glow-pulse 0.3s ease-in-out;
        }
        @keyframes glow-pulse {
          0% { filter: brightness(1); }
          50% { filter: brightness(1.15); }
          100% { filter: brightness(1); }
        }

        /* ─── Exit direction (reverse) ─── */
        ${isOut ? `
          .phase-0 .lettermark { opacity: 1; transform: translate(-50%, -50%); }
          .phase-0 .letter-rest span { opacity: 1; }

          .phase-1 .letter-rest span {
            animation: char-dissolve 0.2s ease-in forwards;
          }
          .phase-1 .letter-rest span:nth-child(4) { animation-delay: 0s; }
          .phase-1 .letter-rest span:nth-child(3) { animation-delay: 0.05s; }
          .phase-1 .letter-rest span:nth-child(2) { animation-delay: 0.1s; }
          .phase-1 .letter-rest span:nth-child(1) { animation-delay: 0.15s; }

          @keyframes char-dissolve {
            to { opacity: 0; transform: translateX(4px); }
          }

          .phase-2 .letter-e {
            animation: e-scatter 0.3s ease-in forwards;
          }
          @keyframes e-scatter {
            to { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
          }
        ` : ''}
      `}</style>

      <div className={`splash-inner phase-${phase}`}>
        {/* Abstract dots */}
        <div className="dot" />
        <div className="dot" />
        <div className="dot" />
        <div className="dot" />
        <div className="dot" />
        <div className="dot" />

        {/* E lettermark */}
        <div className="lettermark letter-e">E</div>

        {/* "pito" characters */}
        <div className="letter-rest">
          <span>p</span>
          <span>i</span>
          <span>t</span>
          <span>o</span>
        </div>
      </div>
    </div>
  );
}
