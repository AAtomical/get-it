"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Loader2,
  Plus,
  Minus,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { VizType } from "@/lib/schemas";
import { VIZ_TYPE_META, vizTypeStyle } from "@/components/Visualizer/viz-meta";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

if (typeof window !== "undefined") {
  GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}

const TAG_LABEL_VISIBLE_CHARS = 8;

export type Tag = {
  id: string;
  page: number; // 0-based
  endX: number;
  endY: number;
  fontHeight: number;
  type: VizType;
  label: string;
  /** Spec arrived — clicking opens the visualization. */
  ready: boolean;
  /** Currently fetching the spec — show spinner, disable click. */
  generating: boolean;
  /** Generation/render failed — show a red ring, clicking re-selects it. */
  error?: string;
};

type Props = {
  pdfUrl: string;
  numPages: number;
  pageDims: Array<{ width: number; height: number }>;
  tags: Tag[];
  activeTagId: string | null;
  onTagClick: (tagId: string) => void;
  detecting?: boolean;
  providerLabel?: string;
};

function truncateTagLabel(label: string): string {
  if (label.length <= TAG_LABEL_VISIBLE_CHARS) return label;
  return `${label.slice(0, TAG_LABEL_VISIBLE_CHARS).trimEnd()}...`;
}

export default function PdfViewer({
  pdfUrl,
  numPages,
  pageDims,
  tags,
  activeTagId,
  onTagClick,
  detecting,
  providerLabel,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [containerW, setContainerW] = useState(0);
  // 1.0 = fit-to-width baseline. Bounded to keep WebGL/canvas sane.
  const [zoomLevel, setZoomLevel] = useState(1);
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.1;
  const zoomIn = useCallback(
    () => setZoomLevel((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2))),
    [],
  );
  const zoomOut = useCallback(
    () => setZoomLevel((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2))),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({ url: pdfUrl });
    task.promise.then((pdf) => {
      if (cancelled) {
        pdf.destroy();
        return;
      }
      setPdfDoc(pdf);
    });
    return () => {
      cancelled = true;
      task.promise.then((p) => p?.destroy?.()).catch(() => {});
    };
  }, [pdfUrl]);

  useEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const measure = () => setContainerW(el.clientWidth - 64); // minus px padding
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Choose a uniform scale based on the widest page so all pages line up.
  const baseScale = useMemo(() => {
    if (!containerW || !pageDims.length) return 1;
    const widest = Math.max(...pageDims.map((p) => p.width));
    const target = Math.min(940, containerW);
    return target / widest;
  }, [containerW, pageDims]);
  const scale = baseScale * zoomLevel;

  // When the active tag changes, scroll to the page that contains it.
  useEffect(() => {
    if (!activeTagId || !scrollRef.current) return;
    const tag = tags.find((t) => t.id === activeTagId);
    if (!tag) return;
    const el = scrollRef.current.querySelector(`[data-page="${tag.page}"]`) as HTMLElement | null;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeTagId, tags]);

  // Track which page contains the viewport center so the page indicator
  // stays in sync with manual scrolling.
  const [currentPage, setCurrentPage] = useState(0);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !numPages) return;
    const onScroll = () => {
      const pages = root.querySelectorAll<HTMLElement>("[data-page]");
      if (!pages.length) return;
      const center = root.scrollTop + root.clientHeight / 2;
      for (const p of pages) {
        if (center >= p.offsetTop && center < p.offsetTop + p.offsetHeight) {
          setCurrentPage(Number(p.dataset.page));
          return;
        }
      }
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [numPages, scale]);

  const [pageEditing, setPageEditing] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const pageInputRef = useRef<HTMLInputElement | null>(null);

  const startPageEdit = useCallback(() => {
    setPageDraft(String(currentPage + 1));
    setPageEditing(true);
  }, [currentPage]);

  const goToPage = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(numPages - 1, idx));
      const root = scrollRef.current;
      if (!root) return;
      const el = root.querySelector(`[data-page="${clamped}"]`) as HTMLElement | null;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [numPages],
  );

  const zoomPercent = Math.round(zoomLevel * 100);
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomDraft, setZoomDraft] = useState("");
  const zoomInputRef = useRef<HTMLInputElement | null>(null);

  const startZoomEdit = useCallback(() => {
    setZoomDraft(String(Math.round(zoomLevel * 100)));
    setZoomEditing(true);
  }, [zoomLevel]);

  const commitZoomEdit = useCallback(() => {
    const parsed = parseFloat(zoomDraft.replace(",", "."));
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parsed / 100));
      setZoomLevel(+clamped.toFixed(2));
    }
    setZoomEditing(false);
  }, [zoomDraft]);

  const commitPageEdit = useCallback(() => {
    const parsed = parseInt(pageDraft, 10);
    if (Number.isFinite(parsed)) goToPage(parsed - 1);
    setPageEditing(false);
  }, [pageDraft, goToPage]);

  useEffect(() => {
    if (zoomEditing) {
      zoomInputRef.current?.focus();
      zoomInputRef.current?.select();
    }
  }, [zoomEditing]);

  useEffect(() => {
    if (pageEditing) {
      pageInputRef.current?.focus();
      pageInputRef.current?.select();
    }
  }, [pageEditing]);

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="relative flex h-full flex-col overflow-y-auto bg-white">
        {detecting && (
          <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-white/90 px-4 py-2 text-[12px] text-[var(--ink-500)] backdrop-blur">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent-600)]" />
            {providerLabel ?? "Codex CLI"} is reading your document and tagging concepts…
          </div>
        )}
        <div className="flex flex-col items-center gap-7 px-6 py-8">
          {Array.from({ length: numPages }).map((_, i) => (
            <PdfPage
              key={i}
              pdfDoc={pdfDoc}
              pageNumber={i + 1}
              pdfWidth={pageDims[i]?.width ?? 595}
              pdfHeight={pageDims[i]?.height ?? 842}
              scale={scale}
              tags={tags.filter((t) => t.page === i)}
              activeTagId={activeTagId}
              onTagClick={onTagClick}
            />
          ))}
        </div>
      </div>

      {/* Page navigation — discreet cluster centered at the bottom */}
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-white/95 p-1 shadow-[0_2px_8px_rgba(17,17,19,0.06)] backdrop-blur">
        <button
          type="button"
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 0}
          className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-700)] transition hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)] disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {pageEditing ? (
          <div className="pointer-events-auto flex items-center px-1">
            <input
              ref={pageInputRef}
              type="text"
              inputMode="numeric"
              value={pageDraft}
              onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={commitPageEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPageEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setPageEditing(false);
                }
              }}
              className="w-8 rounded-sm bg-transparent text-right text-[12px] font-medium tabular-nums text-[var(--ink-900)] outline-none focus:bg-[var(--surface-sunken)]"
              aria-label="Go to page"
            />
            <span className="text-[12px] font-medium text-[var(--ink-700)]">
              &nbsp;/ {numPages || 1}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={startPageEdit}
            className="pointer-events-auto rounded-md px-2 py-0.5 text-[12px] font-medium tabular-nums text-[var(--ink-700)] transition hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
            aria-label="Jump to page"
            title="Click to jump to a specific page"
          >
            {Math.min(currentPage + 1, numPages || 1)} / {numPages || 1}
          </button>
        )}
        <button
          type="button"
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= numPages - 1}
          className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-700)] transition hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)] disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Zoom cluster — bottom-right of the document panel */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-30 flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-white/95 p-1 shadow-[0_2px_8px_rgba(17,17,19,0.06)] backdrop-blur">
        {zoomEditing ? (
          <div className="pointer-events-auto flex items-center px-1">
            <input
              ref={zoomInputRef}
              type="text"
              inputMode="numeric"
              value={zoomDraft}
              onChange={(e) => setZoomDraft(e.target.value.replace(/[^0-9.,]/g, ""))}
              onBlur={commitZoomEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitZoomEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setZoomEditing(false);
                }
              }}
              className="w-10 rounded-sm bg-transparent text-right text-[12px] font-medium tabular-nums text-[var(--ink-900)] outline-none focus:bg-[var(--surface-sunken)]"
              aria-label="Zoom percentage"
            />
            <span className="text-[12px] font-medium text-[var(--ink-700)]">%</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={startZoomEdit}
            className="pointer-events-auto rounded-md px-2 py-0.5 text-[12px] font-medium tabular-nums text-[var(--ink-700)] transition hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
            aria-label="Set custom zoom"
            title="Click to type a custom zoom"
          >
            {zoomPercent}%
          </button>
        )}
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoomLevel >= ZOOM_MAX}
          className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-700)] transition hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)] disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoomLevel <= ZOOM_MIN}
          className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-700)] transition hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)] disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function PdfPage({
  pdfDoc,
  pageNumber,
  pdfWidth,
  pdfHeight,
  scale,
  tags,
  activeTagId,
  onTagClick,
}: {
  pdfDoc: PDFDocumentProxy | null;
  pageNumber: number;
  pdfWidth: number;
  pdfHeight: number;
  scale: number;
  tags: Tag[];
  activeTagId: string | null;
  onTagClick: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!pdfDoc || !scale || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel: () => void } | null = null;
    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio, 2);
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled) {
        page.cleanup();
        return;
      }
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      renderTask = page.render({ canvas, canvasContext: ctx, viewport });
      try {
        await renderTask.promise;
      } catch {
        /* cancelled */
      }
      page.cleanup();
    })();
    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {}
    };
  }, [pdfDoc, pageNumber, scale]);

  return (
    <div
      data-page={pageNumber - 1}
      className="relative shrink-0 bg-white"
      style={{
        width: pdfWidth * scale,
        height: pdfHeight * scale,
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* Tag overlay layer */}
      <div className="pointer-events-none absolute inset-0">
        {tags.map((t) => (
          <TagPill
            key={t.id}
            tag={t}
            scale={scale}
            pdfWidth={pdfWidth}
            pdfHeight={pdfHeight}
            isActive={activeTagId === t.id}
            onClick={() => onTagClick(t.id)}
          />
        ))}
      </div>
      <div className="pointer-events-none absolute -bottom-5 right-2 text-[10px] tabular-nums text-[var(--ink-400)]">
        page {pageNumber}
      </div>
    </div>
  );
}

function TagPill({
  tag,
  scale,
  pdfWidth,
  pdfHeight,
  isActive,
  onClick,
}: {
  tag: Tag;
  scale: number;
  pdfWidth: number;
  pdfHeight: number;
  isActive: boolean;
  onClick: () => void;
}) {
  const { Icon, label: typeLabel } = VIZ_TYPE_META[tag.type];

  const top = (pdfHeight - tag.endY - tag.fontHeight * 0.85) * scale - 1;
  const left = tag.endX * scale + 4;

  const isIdle = !tag.ready && !tag.generating;
  const clickable = tag.ready || isIdle;
  const labelWithType = `${typeLabel}: ${tag.label}`;
  const tooltip = tag.ready
    ? labelWithType
    : tag.generating
      ? `${labelWithType} (preparing visualization...)`
      : tag.error
        ? `${labelWithType} (failed — click to retry)`
        : `${labelWithType} (click to generate)`;
  const tooltipId = `pdf-tag-tooltip-${tag.id}`;
  const stateAttr = tag.ready
    ? "ready"
    : tag.generating
      ? "generating"
      : tag.error
        ? "error"
        : "idle";
  const displayLabel = truncateTagLabel(tag.label);

  return (
    <motion.button
      initial={{ opacity: 0, y: -4, scale: 0.85 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25 }}
      type="button"
      aria-label={tooltip}
      aria-describedby={tooltipId}
      aria-disabled={!clickable}
      onClick={(event) => {
        if (!clickable) {
          event.preventDefault();
          return;
        }
        onClick();
      }}
      data-active={isActive ? "true" : "false"}
      data-state={stateAttr}
      style={{ left, top, ...vizTypeStyle(tag.type) }}
      className="tag-pill viz-tooltip-anchor pointer-events-auto absolute -translate-y-0.5"
    >
      {tag.generating ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <Icon className="h-3 w-3" aria-hidden />
      )}
      <span className="tag-pill-label" aria-hidden>
        {displayLabel}
      </span>
      <span id={tooltipId} className="viz-tooltip" role="tooltip">
        {tooltip}
      </span>
    </motion.button>
  );
}
