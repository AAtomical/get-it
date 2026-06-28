"use client";

import { useEffect, useRef } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { FormulaSpec } from "@/lib/schemas";

function Tex({ tex, displayMode = true }: { tex: string; displayMode?: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(tex, ref.current, {
        throwOnError: false,
        displayMode,
        strict: "ignore",
      });
    } catch (e) {
      ref.current.textContent = tex;
      console.warn("KaTeX render error (falling back to plain text):", e);
    }
  }, [tex, displayMode]);
  return <span ref={ref} />;
}

type Props = { spec: FormulaSpec };

export default function FormulaView({ spec }: Props) {
  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-raised)] px-7 py-6 text-[var(--ink-900)]">
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-6">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--ink-400)]">
          Headline
        </p>
        <div className="text-2xl text-[var(--ink-900)]">
          <Tex tex={spec.main_latex} />
        </div>
      </div>
      <p className="mt-7 mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--ink-400)]">
        Step-by-step derivation
      </p>
      <ol className="space-y-3">
        {spec.steps.map((s, i) => (
          <li
            key={i}
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[10px] font-medium text-[var(--ink-700)]">
                {i + 1}
              </span>
              <p className="text-[12.5px] text-[var(--ink-500)]">{s.explanation}</p>
            </div>
            <div className="text-[15px] text-[var(--ink-900)]">
              <Tex tex={s.latex} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
