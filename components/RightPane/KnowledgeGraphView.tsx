"use client";

/**
 * Knowledge graph view.
 *
 * Renders the doc's concept graph as an SVG. Layout is a clustered
 * radial-hierarchical seed (cluster anchors in an inner ring, satellites in
 * orbits around their anchor) followed by a short force-relaxation pass.
 * Importance is derived from edge degree + page coverage so that the macro
 * concepts of the document end up larger and central.
 *
 * Hover or click a node to bring it into focus — the rest of the graph dims.
 * Clicking opens a centered overlay panel with the same evaluation bars,
 * notes, and quick-tool actions. Polls /api/kg/[docId]/state every 4 s while
 * mounted so scores rise in (near) real time after a tool interaction.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Sparkles, Network, X, Plus, Minus, Maximize2 } from "lucide-react";
import type { KGEvaluation, KGNode, KGEdge, KnowledgeGraph } from "@/lib/kg-types";
import { masteryScore } from "@/lib/kg-types";

type Props = {
  docId: string;
  /**
   * Called when the user clicks a node-action shortcut (e.g. "chat about this
   * concept"). Lets the right pane switch mode and jump straight in.
   */
  onJumpToTool?: (tool: "chat" | "flashcards" | "quizzes" | "feynman", topic: string) => void;
  providerLabel?: string;
};

export default function KnowledgeGraphView({ docId, onJumpToTool, providerLabel }: Props) {
  const [kg, setKg] = useState<KnowledgeGraph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const r = await fetch(`/api/kg/${docId}/state`, { cache: "no-store" });
      if (!r.ok) throw new Error(`state ${r.status}`);
      const j = (await r.json()) as KnowledgeGraph;
      setKg(j);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [docId]);

  // Initial load + ensure-build on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchState();
      if (cancelled) return;
      const r = await fetch(`/api/kg/${docId}/state`).then((x) => x.json());
      if (cancelled) return;
      if (r.status === "missing") {
        setBuilding(true);
        try {
          await fetch(`/api/kg/${docId}/build`, { method: "POST" });
          await fetchState();
        } catch (e) {
          setLoadError((e as Error).message);
        } finally {
          if (!cancelled) setBuilding(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, fetchState]);

  useEffect(() => {
    if (!kg) return;
    const interval = kg.status === "building" ? 2500 : 4500;
    const t = setInterval(() => {
      fetchState();
    }, interval);
    return () => clearInterval(t);
  }, [kg, fetchState]);

  if (loadError && !kg) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <AlertCircle className="h-6 w-6 text-rose-500" />
        <p className="text-[13px] text-[var(--ink-700)]">Couldn&apos;t load the knowledge graph.</p>
        <p className="text-[11px] text-[var(--ink-400)]">{loadError}</p>
      </div>
    );
  }

  if (!kg || kg.status === "building" || building) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <div className="flex gap-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ink-400)] [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ink-400)] [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ink-400)] [animation-delay:300ms]" />
        </div>
        <p className="text-[12.5px] text-[var(--ink-500)]">
          {providerLabel ?? "Codex CLI"} is mapping the document&apos;s concept graph
        </p>
        <p className="text-[10.5px] text-[var(--ink-400)]">
          this runs once per document, in parallel with concept detection
        </p>
      </div>
    );
  }

  if (kg.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <AlertCircle className="h-6 w-6 text-rose-500" />
        <p className="text-[13px] text-[var(--ink-700)]">Graph build failed.</p>
        <p className="text-[11px] text-[var(--ink-400)]">{kg.buildError}</p>
        <button
          type="button"
          onClick={async () => {
            setBuilding(true);
            try {
              await fetch(`/api/kg/${docId}/build`, { method: "POST" });
              await fetchState();
            } finally {
              setBuilding(false);
            }
          }}
          className="mt-2 rounded-md bg-[var(--ink-900)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-black"
        >
          Retry
        </button>
      </div>
    );
  }

  if (kg.status === "missing") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <Network className="h-7 w-7 text-[var(--ink-400)]" />
        <p className="text-[13px] text-[var(--ink-700)]">No graph yet.</p>
      </div>
    );
  }

  const selected = kg.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      {/* Global note ribbon */}
      {kg.globalNote && (
        <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-canvas)] px-5 py-2.5">
          <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-[var(--ink-700)]">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent-600)]" />
            <span>{kg.globalNote}</span>
          </p>
          <p className="mt-1 text-[10.5px] text-[var(--ink-400)]">
            {kg.lastEvaluatedAt
              ? `last evaluated ${humanise(kg.lastEvaluatedAt)} · ${kg.evaluationCount} pass${kg.evaluationCount === 1 ? "" : "es"}`
              : "no evaluations yet — interact with a tool to see scores update"}
          </p>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <GraphCanvas
          nodes={kg.nodes}
          edges={kg.edges}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        <AnimatePresence>
          {selected && (
            <NodeOverlay
              key={selected.id}
              node={selected}
              onClose={() => setSelectedId(null)}
              onJumpToTool={onJumpToTool}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function humanise(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 30_000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  return `${Math.round(dt / 3_600_000)}h ago`;
}

// ── Importance + hierarchical clustered layout ────────────────────────

/**
 * Layout coordinate system: nodes are placed in a "world" that is larger
 * than the visible viewport so the user can pan/zoom around it. The layout
 * algorithm runs in normalised 0..1 space (unclamped — nodes are free to
 * spill outside [0,1]) and the result is scaled to world units at the end.
 */
const WORLD_BASE = 1600;

type LaidOutNode = KGNode & {
  x: number;
  y: number;
  importance: number; // 0..1 normalised
  tier: 0 | 1 | 2; // 0 = anchor (largest), 2 = leaf (smallest)
  clusterId: string; // id of the anchor this node belongs to
};

type AdjMap = Map<string, Set<string>>;

function buildAdjacency(nodes: KGNode[], edges: KGEdge[]): AdjMap {
  const adj: AdjMap = new Map();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  return adj;
}

/** Combine edge degree + page coverage into a 0..1 importance score. */
function computeImportance(nodes: KGNode[], adj: AdjMap): Map<string, number> {
  const raw = new Map<string, number>();
  let max = 0;
  for (const n of nodes) {
    const deg = adj.get(n.id)?.size ?? 0;
    const pages = n.pageHints?.length ?? 0;
    const score = deg * 1.0 + pages * 0.55;
    raw.set(n.id, score);
    if (score > max) max = score;
  }
  if (max === 0) max = 1;
  const out = new Map<string, number>();
  for (const [k, v] of raw) out.set(k, v / max);
  return out;
}

/** Pick K anchor nodes spread out by importance; greedy farthest-from-rest by edge BFS. */
function pickAnchors(
  nodes: KGNode[],
  importance: Map<string, number>,
  adj: AdjMap,
  k: number,
): string[] {
  if (nodes.length === 0) return [];
  const sorted = [...nodes].sort(
    (a, b) => (importance.get(b.id) ?? 0) - (importance.get(a.id) ?? 0),
  );
  const anchors: string[] = [sorted[0].id];
  // BFS distance helper.
  const distFrom = (start: string): Map<string, number> => {
    const d = new Map<string, number>();
    d.set(start, 0);
    const q = [start];
    while (q.length) {
      const u = q.shift()!;
      const du = d.get(u)!;
      for (const v of adj.get(u) ?? []) {
        if (!d.has(v)) {
          d.set(v, du + 1);
          q.push(v);
        }
      }
    }
    return d;
  };
  while (anchors.length < k && anchors.length < sorted.length) {
    // For each candidate (in descending importance), score by min-dist to
    // existing anchors — pick the highest combined score.
    const dists = anchors.map(distFrom);
    let bestId: string | null = null;
    let bestScore = -Infinity;
    for (const cand of sorted) {
      if (anchors.includes(cand.id)) continue;
      const minDist = Math.min(
        ...dists.map((d) => d.get(cand.id) ?? 999),
      );
      const imp = importance.get(cand.id) ?? 0;
      // weight: spread > raw importance, but importance still matters
      const score = minDist * 1.0 + imp * 0.6;
      if (score > bestScore) {
        bestScore = score;
        bestId = cand.id;
      }
    }
    if (!bestId) break;
    anchors.push(bestId);
  }
  return anchors;
}

/** For each node, find its closest anchor by edge BFS distance. */
function assignClusters(
  nodes: KGNode[],
  anchors: string[],
  adj: AdjMap,
  importance: Map<string, number>,
): Map<string, string> {
  const cluster = new Map<string, string>();
  if (anchors.length === 0) return cluster;
  // Multi-source BFS from each anchor.
  const dist = new Map<string, { d: number; anchor: string }>();
  const q: Array<{ id: string; d: number; anchor: string }> = [];
  for (const a of anchors) {
    dist.set(a, { d: 0, anchor: a });
    q.push({ id: a, d: 0, anchor: a });
  }
  while (q.length) {
    const cur = q.shift()!;
    for (const v of adj.get(cur.id) ?? []) {
      const existing = dist.get(v);
      const nd = cur.d + 1;
      if (!existing || nd < existing.d) {
        dist.set(v, { d: nd, anchor: cur.anchor });
        q.push({ id: v, d: nd, anchor: cur.anchor });
      }
    }
  }
  // Disconnected nodes — assign to the most important anchor.
  let fallback = anchors[0];
  let fallbackImp = importance.get(fallback) ?? 0;
  for (const a of anchors) {
    const i = importance.get(a) ?? 0;
    if (i > fallbackImp) {
      fallback = a;
      fallbackImp = i;
    }
  }
  for (const n of nodes) {
    cluster.set(n.id, dist.get(n.id)?.anchor ?? fallback);
  }
  return cluster;
}

function layout(nodes: KGNode[], edges: KGEdge[]): LaidOutNode[] {
  const N = nodes.length;
  if (N === 0) return [];

  const adj = buildAdjacency(nodes, edges);
  const importance = computeImportance(nodes, adj);

  // Anchor count grows gently with graph size.
  const K = Math.max(1, Math.min(7, Math.round(Math.sqrt(N) * 0.9)));
  const anchors = pickAnchors(nodes, importance, adj, K);
  const cluster = assignClusters(nodes, anchors, adj, importance);

  // Tier assignment.
  // Tier 0 = anchor.
  // Tier 1 = direct neighbour of an anchor (within its cluster).
  // Tier 2 = everything else.
  const anchorSet = new Set(anchors);
  const tierOf = (id: string): 0 | 1 | 2 => {
    if (anchorSet.has(id)) return 0;
    const myAnchor = cluster.get(id);
    if (myAnchor && adj.get(myAnchor)?.has(id)) return 1;
    return 2;
  };

  // Place anchors evenly on an inner ring. The ring widens with anchor
  // count so dense graphs spread out instead of crowding the centre.
  const positions = new Map<string, { x: number; y: number }>();
  const innerR = K === 1 ? 0 : 0.09 + Math.min(0.04, K * 0.008);
  anchors.forEach((id, i) => {
    if (K === 1) {
      positions.set(id, { x: 0.5, y: 0.5 });
    } else {
      const angle = (i / K) * Math.PI * 2 - Math.PI / 2;
      positions.set(id, {
        x: 0.5 + Math.cos(angle) * innerR,
        y: 0.5 + Math.sin(angle) * innerR,
      });
    }
  });

  // For each cluster, place children in a ring around the anchor, separated
  // by tier (tier-1 closer in, tier-2 in an outer band).
  for (const a of anchors) {
    const aPos = positions.get(a)!;
    // Direction from canvas center → anchor (so the cluster fans outward).
    const cx = aPos.x - 0.5;
    const cy = aPos.y - 0.5;
    const baseAngle = K === 1 ? -Math.PI / 2 : Math.atan2(cy, cx);

    const members = nodes.filter((n) => cluster.get(n.id) === a && n.id !== a);
    const tier1 = members.filter((n) => tierOf(n.id) === 1);
    const tier2 = members.filter((n) => tierOf(n.id) === 2);

    const placeRing = (
      arr: KGNode[],
      radius: number,
      arc: number, // total angular spread (radians)
      seedJitter: number,
    ) => {
      const M = arr.length;
      if (M === 0) return;
      arr.forEach((n, i) => {
        const t = M === 1 ? 0 : i / (M - 1) - 0.5; // -0.5..0.5
        const h = hash(n.id);
        const jitter = ((h % 1000) / 1000 - 0.5) * seedJitter;
        const angle = baseAngle + t * arc + jitter;
        // Slight per-node radius wobble to avoid perfect-ring artefacts.
        const rJit = ((h >> 10) % 1000) / 1000;
        const r = radius * (0.92 + rJit * 0.18);
        positions.set(n.id, {
          x: aPos.x + Math.cos(angle) * r,
          y: aPos.y + Math.sin(angle) * r,
        });
      });
    };

    // Wider arc when this cluster has many siblings; narrower when it's
    // crammed between anchors. The two tiers sit on visibly distinct rings.
    const arc = K === 1 ? Math.PI * 1.9 : Math.min(Math.PI * 1.45, (Math.PI * 2) / K + 0.55);
    placeRing(tier1, 0.075, arc, 0.16);
    placeRing(tier2, 0.135, arc, 0.28);
  }

  // Any node still unplaced (shouldn't happen, defensive) → drop near center.
  for (const n of nodes) {
    if (!positions.has(n.id)) {
      const h = hash(n.id);
      const angle = (h % 1000) / 1000 * Math.PI * 2;
      const r = 0.05 + ((h >> 10) % 500) / 5000;
      positions.set(n.id, {
        x: 0.5 + Math.cos(angle) * r,
        y: 0.5 + Math.sin(angle) * r,
      });
    }
  }

  // Build the laid-out array.
  const laid: LaidOutNode[] = nodes.map((n) => {
    const p = positions.get(n.id)!;
    return {
      ...n,
      x: p.x,
      y: p.y,
      importance: importance.get(n.id) ?? 0,
      tier: tierOf(n.id),
      clusterId: cluster.get(n.id) ?? n.id,
    };
  });

  // ── Light force-relaxation pass to spread things and respect edges ────
  // The seed is already structured, so we only need a few iterations and
  // a small repulsion to avoid overlaps.
  const idIndex = new Map<string, number>();
  laid.forEach((n, i) => idIndex.set(n.id, i));

  const REPULSION = 0.0014;
  const SPRING = 0.05;
  const TARGET_LEN = 0.06; // edges want to be short; collision sets the real floor
  const ANCHOR_PULL = 0.085; // hold anchors close to seed
  const CENTER_PULL = 0.0022; // very small — keep things from drifting infinitely
  const ITER = 220;

  // Per-node effective radius (in normalised space) used by the hard
  // collision pass. Includes the node circle AND its label below, so two
  // nodes that don't overlap as circles still get pushed apart if their
  // text would collide. This is what gives the layout its Obsidian-style
  // "as compact as possible without text overlap" feel.
  const effR = laid.map((n) => {
    const fontSize = n.tier === 0 ? 70 : n.tier === 1 ? 50 : 38;
    const maxChars = n.tier === 0 ? 16 : n.tier === 1 ? 20 : 24;
    const lines = wrapLabel(n.label, maxChars, 2);
    const widestLine = lines.reduce((m, l) => Math.max(m, l.length), 0);
    // 0.5 × fontSize ≈ average sans-serif glyph advance.
    const labelHalfWidth = (widestLine * fontSize * 0.5) / 2;
    const labelHeight = lines.length * fontSize * 1.15;
    const nodeR =
      18 + n.importance * 34 + (n.tier === 0 ? 16 : n.tier === 1 ? 4 : 0) + 12;
    // Bounding extent below the node centre = node radius + 14px gap + label.
    const totalDown = nodeR + 14 + labelHeight;
    // Use the diagonal of the (halfWidth × verticalSpan/2) bbox, lightly
    // shrunk vertically so stacked nodes don't get pushed too far apart.
    const eff = Math.max(
      nodeR,
      Math.sqrt(labelHalfWidth * labelHalfWidth + totalDown * totalDown * 0.36),
    );
    return eff / WORLD_BASE;
  });
  const COLLISION_PADDING = 0.006;

  const seedX = laid.map((n) => n.x);
  const seedY = laid.map((n) => n.y);

  for (let it = 0; it < ITER; it++) {
    const fx = new Array(N).fill(0);
    const fy = new Array(N).fill(0);

    // Pairwise repulsion (O(N²) — N is small, hundreds at most).
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = laid[i].x - laid[j].x;
        const dy = laid[i].y - laid[j].y;
        const d2 = dx * dx + dy * dy + 1e-4;
        // Bigger nodes push harder.
        const sizeBoost = 1 + (laid[i].importance + laid[j].importance) * 0.6;
        const f = (REPULSION * sizeBoost) / d2;
        fx[i] += dx * f;
        fy[i] += dy * f;
        fx[j] -= dx * f;
        fy[j] -= dy * f;
      }
    }

    // Spring on edges.
    for (const e of edges) {
      const ai = idIndex.get(e.source);
      const bi = idIndex.get(e.target);
      if (ai == null || bi == null) continue;
      const dx = laid[bi].x - laid[ai].x;
      const dy = laid[bi].y - laid[ai].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-4;
      const stretch = (d - TARGET_LEN) * SPRING;
      const ux = dx / d;
      const uy = dy / d;
      fx[ai] += ux * stretch;
      fy[ai] += uy * stretch;
      fx[bi] -= ux * stretch;
      fy[bi] -= uy * stretch;
    }

    // Anchors hold their seed position firmly so the radial layout survives.
    for (let i = 0; i < N; i++) {
      if (laid[i].tier === 0) {
        fx[i] += (seedX[i] - laid[i].x) * ANCHOR_PULL * 8;
        fy[i] += (seedY[i] - laid[i].y) * ANCHOR_PULL * 8;
      } else if (laid[i].tier === 1) {
        fx[i] += (seedX[i] - laid[i].x) * ANCHOR_PULL * 0.6;
        fy[i] += (seedY[i] - laid[i].y) * ANCHOR_PULL * 0.6;
      }
      // Soft, very weak pull toward (0.5, 0.5) so untethered tier-2 leaves
      // don't drift to infinity, but they're still allowed to spill outside
      // the [0,1] box. This is what gives the layout its "navigable beyond
      // the borders" feel.
      fx[i] += (0.5 - laid[i].x) * CENTER_PULL;
      fy[i] += (0.5 - laid[i].y) * CENTER_PULL;
    }

    // Apply with damping that ramps down over iterations. NO wall clamping —
    // nodes are free to spill outside [0,1]; the viewport pans/zooms.
    const damping = 1 - it / (ITER * 1.3);
    for (let i = 0; i < N; i++) {
      laid[i].x += fx[i] * damping;
      laid[i].y += fy[i] * damping;
    }

    // Hard collision pass: position-correction relaxation that prevents
    // any two nodes (including their labels) from overlapping. Anchors get
    // a much smaller share of the push so they stay near their seed and
    // the radial structure survives.
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = laid[i].x - laid[j].x;
        const dy = laid[i].y - laid[j].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-4;
        const minD = effR[i] + effR[j] + COLLISION_PADDING;
        if (d < minD) {
          const push = (minD - d) * 0.5;
          const ux = dx / d;
          const uy = dy / d;
          const wi = laid[i].tier === 0 ? 0.18 : laid[i].tier === 1 ? 0.7 : 1;
          const wj = laid[j].tier === 0 ? 0.18 : laid[j].tier === 1 ? 0.7 : 1;
          const wsum = wi + wj;
          laid[i].x += ux * push * ((2 * wi) / wsum);
          laid[i].y += uy * push * ((2 * wi) / wsum);
          laid[j].x -= ux * push * ((2 * wj) / wsum);
          laid[j].y -= uy * push * ((2 * wj) / wsum);
        }
      }
    }
  }

  // Scale into world coordinates so the SVG viewBox can pan/zoom freely.
  for (const n of laid) {
    n.x *= WORLD_BASE;
    n.y *= WORLD_BASE;
  }

  return laid;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) * 16777619;
  }
  return h >>> 0;
}

/** Spring-flavoured ease for the drag-release tentacle snap-back. */
function easeOutBack(t: number): number {
  const c1 = 1.55;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Word-wrap a label into at most `maxLines` lines of roughly `maxChars`
 * characters each. We never break inside a word; if a single word is
 * longer than maxChars it occupies its own line. If the label doesn't
 * fit in maxLines, the last line ends with an ellipsis.
 */
function wrapLabel(label: string, maxChars: number, maxLines: number): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (next.length <= maxChars || !cur) {
      cur = next;
      i++;
    } else {
      lines.push(cur);
      cur = "";
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (i < words.length && lines.length === maxLines) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] =
      last.length > maxChars - 1 ? last.slice(0, maxChars - 1) + "…" : last + "…";
  }
  return lines;
}

// ── Canvas ────────────────────────────────────────────────────────────

type ViewBox = { x: number; y: number; w: number; h: number };

const MIN_VIEW = 240; // most-zoomed-in viewBox width (world units)
const MAX_VIEW = 8000; // most-zoomed-out viewBox width (world units)
const FIT_PAD = 140; // world-unit padding around the bbox when fitting
/**
 * Cap on the initial viewport width — prevents the auto-fit from zooming so
 * far out that nodes become unreadable on big graphs. Larger graphs simply
 * extend beyond the viewport at first; the user pans/zooms to explore.
 */
const COMFORT_VIEW = 1500;

function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: KGNode[];
  edges: KGEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Initial view: centred on the world origin at COMFORT_VIEW size, so the
  // first paint is close to where the auto-fit lands and there's no big
  // visible "snap" once the layout finishes.
  const [view, setView] = useState<ViewBox>(() => ({
    x: WORLD_BASE / 2 - COMFORT_VIEW / 2,
    y: WORLD_BASE / 2 - COMFORT_VIEW / 2,
    w: COMFORT_VIEW,
    h: COMFORT_VIEW,
  }));
  const [isDragging, setIsDragging] = useState(false);
  // Per-frame drag delta in world units; non-anchor nodes lag behind it for
  // the squishy/tentacle feel. Snaps to (0, 0) on release with a spring
  // ease so leaves visibly settle back to their nominal positions.
  const [dragLag, setDragLag] = useState({ x: 0, y: 0 });
  const dragLagRef = useRef(dragLag);
  dragLagRef.current = dragLag;
  const setLag = useCallback((next: { x: number; y: number }) => {
    dragLagRef.current = next;
    setDragLag(next);
  }, []);

  // Mirror state into refs so the global drag handler reads fresh values
  // without resubscribing on every viewBox change.
  const viewRef = useRef(view);
  viewRef.current = view;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const laid = useMemo(() => layout(nodes, edges), [nodes, edges]);

  // Edge endpoint lookup — O(1) per edge instead of O(N).
  const nodeById = useMemo(() => {
    const m = new Map<string, LaidOutNode>();
    for (const n of laid) m.set(n.id, n);
    return m;
  }, [laid]);

  const masteryById = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.id, masteryScore(n.evaluation));
    return m;
  }, [nodes]);

  // Adjacency for hover/select dimming (1-hop neighbours stay lit).
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of nodes) m.set(n.id, new Set());
    for (const e of edges) {
      m.get(e.source)?.add(e.target);
      m.get(e.target)?.add(e.source);
    }
    return m;
  }, [nodes, edges]);

  // World bbox of laid-out nodes — drives the fit-all view.
  const bbox = useMemo(() => {
    if (laid.length === 0) {
      return { minX: 0, minY: 0, maxX: WORLD_BASE, maxY: WORLD_BASE };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of laid) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    return { minX, minY, maxX, maxY };
  }, [laid]);

  // Initial view: comfort-fit, not strict bbox-fit. Small graphs land fully
  // visible with breathing room; large graphs render at COMFORT_VIEW width
  // (= readable node sizes) and the user pans/zooms to find the rest. This
  // is what gives the demo its "navigable map that extends beyond the
  // borders" feel without sacrificing legibility.
  const fitView = useCallback(() => {
    const aspect = sizeRef.current.w / Math.max(1, sizeRef.current.h);
    const bboxW = bbox.maxX - bbox.minX + FIT_PAD * 2;
    const bboxH = bbox.maxY - bbox.minY + FIT_PAD * 2;
    // Pick the smaller of strict-fit vs. comfort cap.
    const fitW = Math.min(bboxW, COMFORT_VIEW);
    const fitH = Math.min(bboxH, COMFORT_VIEW / aspect);
    // Maintain container aspect (so nothing gets distorted).
    let useW = fitW;
    let useH = fitH;
    if (useW / useH > aspect) {
      useH = useW / aspect;
    } else {
      useW = useH * aspect;
    }
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    setView({ x: cx - useW / 2, y: cy - useH / 2, w: useW, h: useH });
  }, [bbox]);

  // Auto-fit ONCE per mount, the first time we have a non-empty layout and
  // a sized container. Crucially we don't refit on subsequent renders —
  // the /state poll fires every ~4.5s and produces fresh array references
  // even when content is identical, which used to retrigger the auto-fit
  // and made the graph appear to "zoom on its own". After the first fit,
  // only the user (drag, wheel, or the reset button) can change the view.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    if (laid.length === 0) return;
    if (size.w === 0 || size.h === 0) return;
    fitView();
    didFitRef.current = true;
  }, [fitView, size, laid.length]);

  // Inertia + tentacle-lag animation refs.
  const inertiaRafRef = useRef<number | null>(null);
  const springRafRef = useRef<number | null>(null);
  const cancelMotion = useCallback(() => {
    if (inertiaRafRef.current != null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
    if (springRafRef.current != null) {
      cancelAnimationFrame(springRafRef.current);
      springRafRef.current = null;
    }
  }, []);
  useEffect(() => () => cancelMotion(), [cancelMotion]);

  // Wheel zoom around the cursor — preserve container aspect.
  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      cancelMotion();
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mxNorm = (e.clientX - rect.left) / rect.width;
      const myNorm = (e.clientY - rect.top) / rect.height;
      const v = viewRef.current;
      const worldX = v.x + mxNorm * v.w;
      const worldY = v.y + myNorm * v.h;
      const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      const newW = Math.max(MIN_VIEW, Math.min(MAX_VIEW, v.w * factor));
      const aspect = v.w / v.h;
      const newH = newW / aspect;
      setView({
        x: worldX - mxNorm * newW,
        y: worldY - myNorm * newH,
        w: newW,
        h: newH,
      });
    },
    [cancelMotion],
  );

  // Background pan via drag. The handlers attach to window for the duration
  // of the drag so the cursor can leave the SVG and the pan keeps tracking.
  // On release we (a) start a kinetic-inertia tick that decelerates the
  // viewport and (b) spring-animate dragLag back to zero so the leaves
  // settle — together they give the demo its "premium" feel.
  const onBackgroundMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      cancelMotion();
      const startX = e.clientX;
      const startY = e.clientY;
      const startView = { ...viewRef.current };
      let lastClientX = startX;
      let lastClientY = startY;
      let lastT = performance.now();
      let lastWxPerPx = startView.w / Math.max(1, sizeRef.current.w);
      let lastWyPerPx = startView.h / Math.max(1, sizeRef.current.h);
      // World-units / 16ms (i.e. per-frame) — used to seed inertia on release.
      let velX = 0;
      let velY = 0;
      let moved = false;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 3) {
          moved = true;
          setIsDragging(true);
        }
        if (!moved) return;
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return;
        lastWxPerPx = startView.w / rect.width;
        lastWyPerPx = startView.h / rect.height;
        setView({
          x: startView.x - dx * lastWxPerPx,
          y: startView.y - dy * lastWyPerPx,
          w: startView.w,
          h: startView.h,
        });

        // Per-frame world delta — feeds both the lag effect and the
        // post-release inertia velocity.
        const frameDx = (ev.clientX - lastClientX) * lastWxPerPx;
        const frameDy = (ev.clientY - lastClientY) * lastWyPerPx;
        const now = performance.now();
        const dt = Math.max(1, now - lastT);
        // Smoothed velocity (light EMA so a jittery final frame doesn't
        // dominate inertia). Velocity sign matches "where the world content
        // is moving" (= opposite of the drag delta from camera POV).
        velX = velX * 0.4 + (-frameDx * (16 / dt)) * 0.6;
        velY = velY * 0.4 + (-frameDy * (16 / dt)) * 0.6;
        // Tentacle lag: how much the leaves "trail" the drag this frame.
        // Sign matches the world-content motion so leaves render shifted
        // opposite to the drag direction (= they appear to lag).
        setLag({ x: -frameDx * 1.6, y: -frameDy * 1.6 });
        lastClientX = ev.clientX;
        lastClientY = ev.clientY;
        lastT = now;
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (!moved) {
          onSelect(null);
          return;
        }
        setIsDragging(false);

        // (a) Spring-back the lag to (0, 0) with a light overshoot.
        const startLag = { ...dragLagRef.current };
        const SPRING_MS = 480;
        const springStart = performance.now();
        const stepSpring = () => {
          const t = Math.min(1, (performance.now() - springStart) / SPRING_MS);
          const eased = easeOutBack(t);
          const remaining = 1 - eased;
          setLag({ x: startLag.x * remaining, y: startLag.y * remaining });
          if (t < 1) {
            springRafRef.current = requestAnimationFrame(stepSpring);
          } else {
            setLag({ x: 0, y: 0 });
            springRafRef.current = null;
          }
        };
        springRafRef.current = requestAnimationFrame(stepSpring);

        // (b) Kinetic inertia on the viewport — decelerates with friction.
        const FRICTION = 0.9;
        const stepInertia = () => {
          if (Math.abs(velX) < 0.4 && Math.abs(velY) < 0.4) {
            inertiaRafRef.current = null;
            return;
          }
          setView((curr) => ({ ...curr, x: curr.x + velX, y: curr.y + velY }));
          velX *= FRICTION;
          velY *= FRICTION;
          inertiaRafRef.current = requestAnimationFrame(stepInertia);
        };
        if (Math.abs(velX) > 0.4 || Math.abs(velY) > 0.4) {
          inertiaRafRef.current = requestAnimationFrame(stepInertia);
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onSelect, cancelMotion],
  );

  // Programmatic zoom (button controls) — anchor on viewport centre.
  const zoomBy = useCallback(
    (factor: number) => {
      cancelMotion();
      setView((v) => {
        const cx = v.x + v.w / 2;
        const cy = v.y + v.h / 2;
        const newW = Math.max(MIN_VIEW, Math.min(MAX_VIEW, v.w * factor));
        const aspect = v.w / v.h;
        const newH = newW / aspect;
        return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
      });
    },
    [cancelMotion],
  );

  const onResetView = useCallback(() => {
    cancelMotion();
    fitView();
  }, [fitView, cancelMotion]);

  // Active focus = hover wins over selection so hover-preview feels live.
  const focusId = hoveredId ?? selectedId;
  const focusNeighbours = focusId ? neighbours.get(focusId) ?? new Set() : null;

  const isFocused = (id: string) =>
    focusId == null || id === focusId || (focusNeighbours?.has(id) ?? false);

  const isEdgeFocused = (e: KGEdge) =>
    focusId == null || e.source === focusId || e.target === focusId;

  // Node radius in WORLD units. Smaller than before — labels carry most of
  // the visual weight (Obsidian-style), so anchors don't need to be huge to
  // read as "important". The hierarchy comes through via the tier bonus
  // and the bolder/larger label below the node.
  const radiusOf = (n: LaidOutNode, hovered: boolean) => {
    const base = 18 + n.importance * 34; // 18..52 world units
    const tierBonus = n.tier === 0 ? 16 : n.tier === 1 ? 4 : 0;
    return base + tierBonus + (hovered ? 6 : 0);
  };

  // How much each tier "trails" the camera during a drag (0 = perfect 1:1
  // follow, higher = visible lag). Anchors lock to the camera so the user
  // always grabs them firmly; leaves drift, which is what gives the
  // motion its tentacle/squishy feel. The animation is driven entirely by
  // the JS spring loop in onUp — no CSS transition needed (per-frame React
  // rerenders are already smooth, and a CSS transition would fight RAF).
  const lagWeightFor = (tier: 0 | 1 | 2) =>
    tier === 0 ? 0 : tier === 1 ? 0.32 : 0.6;
  const lagFor = (tier: 0 | 1 | 2) => {
    const w = lagWeightFor(tier);
    return { dx: dragLag.x * w, dy: dragLag.y * w };
  };

  // Background rect lives in current viewBox coords so it always covers
  // exactly the visible area for click/drag capture.
  const bgRect = (
    <rect
      x={view.x}
      y={view.y}
      width={view.w}
      height={view.h}
      fill="#ffffff"
      fillOpacity={0}
      onMouseDown={onBackgroundMouseDown}
      style={{ cursor: isDragging ? "grabbing" : "grab" }}
    />
  );

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-white">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="block touch-none select-none"
        onWheel={onWheel}
      >
        {bgRect}

        {/* Edges */}
        <g>
          {edges.map((e, i) => {
            const a = nodeById.get(e.source);
            const b = nodeById.get(e.target);
            if (!a || !b) return null;
            const aLag = lagFor(a.tier);
            const bLag = lagFor(b.tier);
            const lit = isEdgeFocused(e);
            const involves = focusId && (e.source === focusId || e.target === focusId);
            return (
              <line
                key={i}
                x1={a.x + aLag.dx}
                y1={a.y + aLag.dy}
                x2={b.x + bLag.dx}
                y2={b.y + bLag.dy}
                stroke={involves ? "#4f5ae0" : "#d8d6d2"}
                strokeWidth={involves ? 3 : 2}
                vectorEffect="non-scaling-stroke"
                opacity={lit ? (focusId && !involves ? 0.55 : 1) : 0.08}
                style={{ transition: "opacity 220ms ease, stroke 220ms ease" }}
              />
            );
          })}
        </g>

        {/* Nodes */}
        <g>
          {laid.map((n) => {
            const score = masteryById.get(n.id) ?? 0;
            const fill = scoreToColor(score);
            const isSelected = selectedId === n.id;
            const isHovered = hoveredId === n.id;
            const focused = isFocused(n.id);
            const r = radiusOf(n, isHovered || isSelected);

            // Halo glow on focused node — that's the "shadow" focus cue.
            const showHalo = focused && (isHovered || isSelected);

            // Font sizes in world units. Generous so labels survive a
            // moderate zoom-out for the overview view. Wrapped to 2 lines
            // so long labels don't extend past the cluster. Tier-0 anchors
            // are visibly bigger to make hierarchy land at a glance.
            const fontSize = n.tier === 0 ? 70 : n.tier === 1 ? 50 : 38;
            const fontWeight = n.tier === 0 ? 700 : n.tier === 1 ? 500 : 400;
            const labelLines = wrapLabel(
              n.label,
              n.tier === 0 ? 16 : n.tier === 1 ? 20 : 24,
              2,
            );

            const lag = lagFor(n.tier);

            return (
              <g
                key={n.id}
                transform={`translate(${n.x + lag.dx}, ${n.y + lag.dy})`}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredId(n.id)}
                onMouseLeave={() => setHoveredId((h) => (h === n.id ? null : h))}
                onClick={(ev) => {
                  ev.stopPropagation();
                  // Don't trigger select while a pan drag was in progress.
                  if (isDragging) return;
                  onSelect(isSelected ? null : n.id);
                }}
                style={{
                  opacity: focused ? 1 : 0.18,
                  transition: "opacity 220ms ease",
                }}
              >
                {showHalo && (
                  <circle
                    r={r + 36}
                    fill={fill}
                    opacity={0.16}
                    style={{ transition: "r 180ms ease, opacity 220ms ease" }}
                  />
                )}
                {/* White backing so labels/edges under the node disappear */}
                <circle
                  r={r + 12}
                  fill="white"
                  stroke={isSelected ? "#111113" : "transparent"}
                  strokeWidth={isSelected ? 4 : 0}
                  vectorEffect="non-scaling-stroke"
                  style={{ transition: "stroke 180ms ease" }}
                />
                <circle
                  r={r}
                  fill={fill}
                  stroke="#fff"
                  strokeWidth={3}
                  vectorEffect="non-scaling-stroke"
                  style={{ transition: "r 180ms ease" }}
                />
                <text
                  x={0}
                  y={r + 14}
                  fontSize={fontSize}
                  fontWeight={fontWeight}
                  fill="#1a1a1d"
                  textAnchor="middle"
                  dominantBaseline="hanging"
                  style={{
                    pointerEvents: "none",
                    userSelect: "none",
                  }}
                >
                  {labelLines.map((line, idx) => (
                    <tspan key={idx} x={0} dy={idx === 0 ? 0 : fontSize * 1.15}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Hint — drag to pan, scroll to zoom */}
      <div className="pointer-events-none absolute bottom-3 left-3 select-none rounded-md bg-white/85 px-2 py-1 text-[10px] text-[var(--ink-500)] shadow-[0_1px_0_rgba(17,17,19,0.04)] backdrop-blur-sm">
        drag to pan · scroll to zoom
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-white/95 shadow-[0_8px_24px_rgba(17,17,19,0.08)] backdrop-blur-sm">
        <button
          type="button"
          onClick={() => zoomBy(0.8)}
          title="Zoom in"
          className="flex h-7 w-7 items-center justify-center text-[var(--ink-700)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <div className="h-px bg-[var(--border-subtle)]" />
        <button
          type="button"
          onClick={() => zoomBy(1.25)}
          title="Zoom out"
          className="flex h-7 w-7 items-center justify-center text-[var(--ink-700)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <div className="h-px bg-[var(--border-subtle)]" />
        <button
          type="button"
          onClick={onResetView}
          title="Fit graph"
          className="flex h-7 w-7 items-center justify-center text-[var(--ink-700)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function scoreToColor(score: number): string {
  if (score < 1) return "#b6b6ba";
  if (score < 25) return "#7e9bc8";
  if (score < 50) return "#8b78d9";
  if (score < 75) return "#4fae84";
  return "#16a06d";
}

// ── Centered overlay panel ────────────────────────────────────────────

function NodeOverlay({
  node,
  onClose,
  onJumpToTool,
}: {
  node: KGNode;
  onClose: () => void;
  onJumpToTool?: (tool: "chat" | "flashcards" | "quizzes" | "feynman", topic: string) => void;
}) {
  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="absolute inset-0 z-30 flex items-center justify-center px-6"
      onClick={onClose}
    >
      {/* Backdrop — dims the graph behind so the focused panel pops */}
      <div className="absolute inset-0 bg-white/55 backdrop-blur-[2px]" />

      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.98 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-white shadow-[0_24px_60px_rgba(17,17,19,0.18),_0_4px_12px_rgba(17,17,19,0.06)]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-400)]">
              Concept
            </p>
            <p className="mt-0.5 text-[15px] font-semibold leading-tight text-[var(--ink-900)]">
              {node.label}
            </p>
            {node.pageHints.length > 0 && (
              <p className="mt-1 text-[10.5px] text-[var(--ink-400)]">
                pages: {node.pageHints.join(", ")}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ink-500)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
            title="Close"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[55vh] overflow-y-auto px-5 py-4">
          <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--ink-700)]">{node.summary}</p>

          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
            Evaluation
          </p>
          <EvalBars e={node.evaluation} />

          <div className="my-4 h-px bg-[var(--border-subtle)]" />

          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
            What to work on
          </p>
          <p className="text-[12.5px] leading-relaxed text-[var(--ink-700)]">
            {node.evaluatorNote || (
              <span className="text-[var(--ink-400)]">
                No evaluator note yet — interact with this concept (chat, flashcards, quizzes, or
                feynman) and an updated note will appear here.
              </span>
            )}
          </p>
        </div>

        <footer className="grid grid-cols-4 gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--surface-canvas)] p-2.5">
          <button
            type="button"
            onClick={() => onJumpToTool?.("chat", node.label)}
            className="rounded-md border border-[var(--border-subtle)] bg-white px-2 py-1.5 text-[11.5px] font-medium text-[var(--ink-700)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
          >
            Chat
          </button>
          <button
            type="button"
            onClick={() => onJumpToTool?.("flashcards", node.label)}
            className="rounded-md border border-[var(--border-subtle)] bg-white px-2 py-1.5 text-[11.5px] font-medium text-[var(--ink-700)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
          >
            Flashcards
          </button>
          <button
            type="button"
            onClick={() => onJumpToTool?.("quizzes", node.label)}
            className="rounded-md border border-[var(--border-subtle)] bg-white px-2 py-1.5 text-[11.5px] font-medium text-[var(--ink-700)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
          >
            Quizzes
          </button>
          <button
            type="button"
            onClick={() => onJumpToTool?.("feynman", node.label)}
            className="rounded-md border border-[var(--border-subtle)] bg-white px-2 py-1.5 text-[11.5px] font-medium text-[var(--ink-700)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-900)]"
          >
            Feynman
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}

function EvalBars({ e }: { e: KGEvaluation }) {
  return (
    <div className="space-y-2">
      <Bar label="Memory" value={e.memory} />
      <Bar label="Comprehension" value={e.comprehension} />
      <Bar label="Structure" value={e.structure} />
      <Bar label="Application" value={e.application} />
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-[11px]">
        <span className="text-[var(--ink-700)]">{label}</span>
        <span className="tabular-nums text-[var(--ink-500)]">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{
            width: `${Math.min(100, Math.max(0, value))}%`,
            background: scoreToColor(value),
          }}
        />
      </div>
    </div>
  );
}
