"use client";

/**
 * Right-pane shell.
 *
 * Replaces the dedicated Visualizer pane with a multi-tool surface.
 * The header carries a dropdown that switches between six tools:
 *
 *   - Visualizer       (the original concept-renderer; per-tag click)
 *   - Knowledge Graph  (concept map + evaluation scores)
 *   - Chat             (multi-turn, multi-thread Q&A)
 *   - Flashcards       (active recall decks with self-grading)
 *   - Quizzes          (forced-choice multiple-choice quizzes)
 *   - Feynman          (plain-language explanation questions, 4 turns)
 *
 * The Visualizer view is essentially the original component, lifted into
 * here so the chrome (mode chip + title) lives in one place.
 */

import { useEffect, useRef, useState } from "react";
import {
  Sigma,
  MessageSquare,
  Layers,
  ListChecks,
  Network,
  Lightbulb,
  ChevronDown,
  MoreHorizontal,
  Download,
  RefreshCw,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import type { VizSpec } from "@/lib/schemas";
import ThreeDView from "@/components/Visualizer/ThreeDView";
import TwoDAnimView from "@/components/Visualizer/TwoDAnimView";
import TwoDTextView from "@/components/Visualizer/TwoDTextView";
import FormulaView from "@/components/Visualizer/FormulaView";
import GraphView from "@/components/Visualizer/GraphView";
import VizLegendIcon from "@/components/Visualizer/VizLegendIcon";
import {
  VIZ_LEGEND_ORDER,
  VIZ_TYPE_META,
  vizTypeStyle,
} from "@/components/Visualizer/viz-meta";

import KnowledgeGraphView from "./KnowledgeGraphView";
import ChatView from "./ChatView";
import FlashcardsView from "./FlashcardsView";
import QuizzesView from "./QuizzesView";
import FeynmanView from "./FeynmanView";

export type RightPaneMode =
  | "visualizer"
  | "graph"
  | "chat"
  | "flashcards"
  | "quizzes"
  | "feynman";

const MODES: Array<{
  id: RightPaneMode;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  description: string;
}> = [
  {
    id: "visualizer",
    label: "Visualizer",
    Icon: Sigma,
    description: "Render the active tag as 3D / animation / formula / graph / source",
  },
  {
    id: "graph",
    label: "Knowledge Graph",
    Icon: Network,
    description: "Map of concepts with live mastery scores",
  },
  {
    id: "chat",
    label: "Chat",
    Icon: MessageSquare,
    description: "Multi-turn Q&A about the document",
  },
  {
    id: "flashcards",
    label: "Flashcards",
    Icon: Layers,
    description: "Active-recall decks with self-grading",
  },
  {
    id: "quizzes",
    label: "Quizzes",
    Icon: ListChecks,
    description: "Forced-choice multiple-choice quizzes with explanations",
  },
  {
    id: "feynman",
    label: "Feynman",
    Icon: Lightbulb,
    description: "Clarify a topic through guided plain-language questions",
  },
];

type Props = {
  docId: string;
  mode: RightPaneMode;
  onModeChange: (m: RightPaneMode) => void;
  providerLabel?: string;
  // Visualizer-only props (forwarded as-is from the orchestrator)
  visualizer: {
    spec: VizSpec | null;
    loading: boolean;
    emptyHint?: string;
    loadingDetail?: string;
    onRuntimeError?: (msg: string) => void;
    activeTagError?: string | null;
    onRetry?: () => void;
  };
};

export default function RightPane({ docId, mode, onModeChange, visualizer, providerLabel }: Props) {
  return (
    <div className="flex h-full flex-col bg-white">
      <Header
        docId={docId}
        mode={mode}
        onModeChange={onModeChange}
        visualizerSpec={visualizer.spec}
      />

      <div className="relative min-h-0 flex-1 bg-white">
        {mode === "visualizer" && (
          <VisualizerBody
            spec={visualizer.spec}
            loading={visualizer.loading}
            emptyHint={visualizer.emptyHint}
            loadingDetail={visualizer.loadingDetail}
            onRuntimeError={visualizer.onRuntimeError}
            providerLabel={providerLabel}
          />
        )}
        {mode === "graph" && (
          <KnowledgeGraphView
            docId={docId}
            providerLabel={providerLabel}
            onJumpToTool={(tool, topic) => {
              onModeChange(tool);
              // Pre-fill is handled inside each tool via sessionStorage hint.
              try {
                window.sessionStorage.setItem(
                  `getit:${docId}:tool-prefill`,
                  JSON.stringify({ tool, topic, ts: Date.now() }),
                );
              } catch {
                /* noop */
              }
            }}
          />
        )}
        {mode === "chat" && <ChatView docId={docId} />}
        {mode === "flashcards" && <FlashcardsView docId={docId} />}
        {mode === "quizzes" && <QuizzesView docId={docId} />}
        {mode === "feynman" && <FeynmanView docId={docId} />}
      </div>

      {mode === "visualizer" && visualizer.spec && (
        <footer className="shrink-0 border-t border-[var(--border-subtle)] bg-white px-5 py-3">
          <p className="text-[12.5px] leading-relaxed text-[var(--ink-700)]">
            {visualizer.spec.caption}
          </p>
        </footer>
      )}
      {mode === "visualizer" && visualizer.activeTagError && (
        <div className="flex shrink-0 items-start justify-between gap-3 border-t border-amber-200 bg-amber-50 px-5 py-3">
          <p className="text-[12px] text-amber-800">{visualizer.activeTagError}</p>
          {visualizer.onRetry && (
            <button
              type="button"
              onClick={visualizer.onRetry}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 transition hover:bg-amber-100"
            >
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Header (mode dropdown + active title) ─────────────────────────────

function Header({
  docId,
  mode,
  onModeChange,
  visualizerSpec,
}: {
  docId: string;
  mode: RightPaneMode;
  onModeChange: (m: RightPaneMode) => void;
  visualizerSpec: VizSpec | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!moreOpen) return;
    const onClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const downloadWorkContext = async () => {
    setDownloading(true);
    try {
      const r = await fetch(`/api/work-context/${docId}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const data = await r.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `getit-work-context-${docId.slice(0, 8)}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a tick before revoking so the download actually starts.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.warn("[getit] work-context download failed", e);
    } finally {
      setDownloading(false);
      setMoreOpen(false);
    }
  };

  const current = MODES.find((m) => m.id === mode)!;
  const CurrentIcon = current.Icon;

  // Subtitle: viz title when visualizer mode + spec, else mode description.
  const subtitle =
    mode === "visualizer" && visualizerSpec
      ? visualizerSpec.title
      : mode === "visualizer"
        ? "Pick a tag to begin"
        : current.description;

  return (
    <header className="relative flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-white px-5 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <div ref={ref} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors ${
              open
                ? "border-[var(--accent-100)] bg-[var(--accent-50)] text-[var(--accent-700)]"
                : "border-[var(--border-subtle)] bg-white text-[var(--ink-900)] hover:bg-[var(--surface-sunken)]"
            }`}
          >
            <CurrentIcon className="h-3 w-3" />
            {current.label}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          <AnimatePresence>
            {open && (
              <motion.div
                key="menu"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.12 }}
                className="absolute left-0 top-full z-20 mt-1.5 w-72 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-white shadow-[0_8px_24px_rgba(17,17,19,0.08)]"
              >
                {MODES.map((m) => {
                  const Icon = m.Icon;
                  const active = m.id === mode;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        onModeChange(m.id);
                        setOpen(false);
                      }}
                      className={`flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                        active
                          ? "bg-[var(--accent-50)]"
                          : "hover:bg-[var(--surface-sunken)]"
                      }`}
                    >
                      <Icon
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                          active ? "text-[var(--accent-700)]" : "text-[var(--ink-500)]"
                        }`}
                      />
                      <div className="min-w-0">
                        <p
                          className={`text-[12.5px] font-medium ${
                            active ? "text-[var(--accent-700)]" : "text-[var(--ink-900)]"
                          }`}
                        >
                          {m.label}
                        </p>
                        <p className="text-[11px] leading-relaxed text-[var(--ink-500)]">
                          {m.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Visualizer-mode shows the viz-type chip + title; other modes show the mode description */}
        {mode === "visualizer" && visualizerSpec && (
          <span className="viz-type-chip" style={vizTypeStyle(visualizerSpec.type)}>
            {(() => {
              const Icon = VIZ_TYPE_META[visualizerSpec.type].Icon;
              return <Icon className="h-3 w-3" aria-hidden />;
            })()}
            {VIZ_TYPE_META[visualizerSpec.type].label}
          </span>
        )}
        <p className="truncate text-[13.5px] font-medium text-[var(--ink-900)]">{subtitle}</p>
      </div>
      <div ref={moreRef} className="relative">
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className="tab-icon-btn"
          aria-label="More actions"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        <AnimatePresence>
          {moreOpen && (
            <motion.div
              key="more-menu"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              className="absolute right-0 top-full z-20 mt-1.5 w-72 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-white shadow-[0_8px_24px_rgba(17,17,19,0.08)]"
            >
              <button
                type="button"
                onClick={downloadWorkContext}
                disabled={downloading}
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-sunken)] disabled:opacity-60"
              >
                <Download className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ink-500)]" />
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium text-[var(--ink-900)]">
                    {downloading ? "Preparing download…" : "Download work context (JSON)"}
                  </p>
                  <p className="text-[11px] leading-relaxed text-[var(--ink-500)]">
                    Your full interaction journal — chats, flashcards, quizzes, Feynman sessions —
                    exactly as the evaluator sees it right now.
                  </p>
                </div>
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}

// ── Visualizer body (extracted from the original Visualizer component) ─

function VisualizerBody({
  spec,
  loading,
  emptyHint,
  loadingDetail,
  onRuntimeError,
  providerLabel,
}: {
  spec: VizSpec | null;
  loading: boolean;
  emptyHint?: string;
  loadingDetail?: string;
  onRuntimeError?: (msg: string) => void;
  providerLabel?: string;
}) {
  return (
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
            <p className="text-xs">{providerLabel ?? "Codex CLI"} is composing the visualization</p>
            {loadingDetail && <p className="text-[11px] text-[var(--ink-400)]">{loadingDetail}</p>}
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
  );
}
