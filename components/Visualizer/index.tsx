"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Sigma, MoreHorizontal } from "lucide-react";
import type { VizSpec } from "@/lib/schemas";
import ThreeDView from "./ThreeDView";
import TwoDAnimView from "./TwoDAnimView";
import TwoDTextView from "./TwoDTextView";
import FormulaView from "./FormulaView";
import GraphView from "./GraphView";
import VizLegendIcon from "./VizLegendIcon";
import { VIZ_LEGEND_ORDER, VIZ_TYPE_META, vizTypeStyle } from "./viz-meta";

type Props = {
  spec: VizSpec | null;
  loading?: boolean;
  emptyHint?: string;
  /** Loader sub-line (e.g. "fixing… (attempt 2/4)"). */
  loadingDetail?: string;
  /**
   * Called by the renderer if the spec failed to compile or run. The
   * orchestrator decides whether to retry via codex.
   */
  onRuntimeError?: (message: string) => void;
};

export default function Visualizer({ spec, loading, emptyHint, loadingDetail, onRuntimeError }: Props) {
  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-white px-5 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {spec ? (
            <span className="viz-type-chip" style={vizTypeStyle(spec.type)}>
              {(() => {
                const Icon = VIZ_TYPE_META[spec.type].Icon;
                return <Icon className="h-3 w-3" aria-hidden />;
              })()}
              {VIZ_TYPE_META[spec.type].label}
            </span>
          ) : (
            <span className="chip-plain">
              <Sigma className="h-3 w-3" />
              Visualizer
            </span>
          )}
          <p className="truncate text-[13.5px] font-medium text-[var(--ink-900)]">
            {spec ? spec.title : loading ? "Preparing visualization…" : "Pick a tag to begin"}
          </p>
        </div>
        <button type="button" className="tab-icon-btn">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 bg-white">
        <AnimatePresence mode="wait">
          {loading && !spec && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              <div className="flex flex-col items-center gap-3 text-[var(--ink-500)]">
                <div className="flex gap-1">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ink-400)] [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ink-400)] [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ink-400)] [animation-delay:300ms]" />
                </div>
                <p className="text-xs">The AI engine is composing the visualization</p>
                {loadingDetail && (
                  <p className="text-[11px] text-[var(--ink-400)]">{loadingDetail}</p>
                )}
              </div>
            </motion.div>
          )}

          {!spec && !loading && (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center px-8 text-center"
            >
              <div className="max-w-sm">
                <div className="mb-4 flex justify-center gap-2.5">
                  {VIZ_LEGEND_ORDER.map((type) => (
                    <VizLegendIcon key={type} type={type} />
                  ))}
                </div>
                <p className="text-[13.5px] leading-relaxed text-[var(--ink-500)]">
                  {emptyHint ?? "Click any tag in the document to render its concept here."}
                </p>
              </div>
            </motion.div>
          )}

          {spec && (
            <motion.div
              key={spec.title}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0"
            >
              {spec.type === "3d" && <ThreeDView spec={spec} onRuntimeError={onRuntimeError} />}
              {spec.type === "2d-anim" && <TwoDAnimView spec={spec} onRuntimeError={onRuntimeError} />}
              {spec.type === "2d-text" && <TwoDTextView spec={spec} />}
              {spec.type === "formula" && <FormulaView spec={spec} />}
              {spec.type === "graph" && <GraphView spec={spec} onRuntimeError={onRuntimeError} />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {spec && (
        <footer className="shrink-0 border-t border-[var(--border-subtle)] bg-white px-5 py-3">
          <p className="text-[12.5px] leading-relaxed text-[var(--ink-700)]">{spec.caption}</p>
        </footer>
      )}
    </div>
  );
}
