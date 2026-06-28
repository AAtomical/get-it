import Link from "next/link";
import UploadCard from "@/components/UploadCard";
import AccountButton from "@/components/AccountButton";
import SettingsButton from "@/components/SettingsButton";
import TooltipChip from "@/components/TooltipChip";
import WelcomePopup from "@/components/WelcomePopup";
import { APP_VERSION } from "@/lib/version";
import {
  Upload,
  BookOpen,
  FileText,
  StickyNote,
  Bookmark,
  NotebookPen,
  ScrollText,
  Spline,
  Workflow,
  Shuffle,
  Undo2,
  Redo2,
} from "lucide-react";

// Subtle background ornaments that fill the empty side margins on wider
// screens. Hidden below `lg` so they never crowd the content.
const ORNAMENTS = [
  { Icon: FileText,    side: "left",  top: "6%",  off: "5%",  rot: -10, size: 56 },
  { Icon: Bookmark,    side: "left",  top: "26%", off: "12%", rot: -18, size: 38 },
  { Icon: Spline,      side: "left",  top: "44%", off: "3%",  rot: 14,  size: 64 },
  { Icon: NotebookPen, side: "left",  top: "62%", off: "9%",  rot: -6,  size: 48 },
  { Icon: Undo2,       side: "left",  top: "82%", off: "4%",  rot: 22,  size: 52 },
  { Icon: ScrollText,  side: "right", top: "10%", off: "6%",  rot: 12,  size: 60 },
  { Icon: Workflow,    side: "right", top: "30%", off: "2%",  rot: -8,  size: 50 },
  { Icon: StickyNote,  side: "right", top: "50%", off: "10%", rot: 18,  size: 44 },
  { Icon: Shuffle,     side: "right", top: "68%", off: "4%",  rot: -14, size: 56 },
  { Icon: Redo2,       side: "right", top: "86%", off: "11%", rot: 8,   size: 46 },
] as const;

export default function Home() {
  return (
    <main className="relative flex flex-1 min-h-0 flex-col bg-[var(--surface-canvas)] text-[var(--ink-900)]">
      {/* Top tab bar — Reflect-style browser-tabs */}
      <div className="tab-bar tab-bar--fused">
        <div className="tab-item" data-active="true">
          <Upload className="h-3.5 w-3.5 text-[var(--accent-600)]" />
          <span>Upload</span>
        </div>
        <TooltipChip tip="Your library of opened PDFs.">
          <Link href="/library" aria-label="Open library" className="tab-item">
            <BookOpen className="h-3.5 w-3.5 text-[var(--ink-400)]" />
            <span>Library</span>
          </Link>
        </TooltipChip>
        <div className="ml-auto flex items-center gap-1 pr-1">
          <SettingsButton />
          <AccountButton />
        </div>
      </div>

      {/* White content sheet */}
      <div className="relative flex-1 overflow-y-auto overflow-x-hidden bg-[var(--surface-raised)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 hidden select-none lg:block"
        >
          {ORNAMENTS.map(({ Icon, side, top, off, rot, size }, i) => (
            <Icon
              key={i}
              strokeWidth={1.4}
              className="absolute text-[var(--ink-900)]/[0.05]"
              style={{
                top,
                [side]: off,
                width: size,
                height: size,
                transform: `rotate(${rot}deg)`,
              }}
            />
          ))}
        </div>
        <div className="relative">
          <UploadCard />
        </div>
      </div>
      {/* Version tag — pinned to the bottom-right of the page so it stays
          put when the content sheet scrolls. Sibling of the scroll
          container, anchored against <main>. */}
      <div
        className="pointer-events-none absolute bottom-3 right-4 z-10 text-[13px] font-medium tabular-nums text-[var(--ink-400)]"
        aria-label={`Get It. version ${APP_VERSION}`}
      >
        v{APP_VERSION}
      </div>
      <WelcomePopup />
    </main>
  );
}
