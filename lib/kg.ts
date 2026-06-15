/**
 * Server-side persistence for the knowledge graph.
 *
 * Pure types + helpers live in lib/kg-types.ts so client components can
 * import them without bundling node:fs. This file is the disk side: load,
 * save, and the empty-state factory. Stored at
 * <DATA_DIR>/docs/<docId>/kg.json — see lib/paths.ts.
 */

import fs from "node:fs";
import { ensureDocDir, kgPath } from "./paths";
import type { KnowledgeGraph } from "./kg-types";

export type {
  KGEvaluation,
  KGNode,
  KGEdge,
  KnowledgeGraphStatus,
  KnowledgeGraph,
} from "./kg-types";
export { masteryScore } from "./kg-types";

export function loadKG(docId: string): KnowledgeGraph | null {
  try {
    const raw = fs.readFileSync(kgPath(docId), "utf-8");
    const parsed = JSON.parse(raw) as KnowledgeGraph;
    if (parsed && parsed.v === 1) return parsed;
  } catch {
    /* file missing or malformed */
  }
  return null;
}

export function saveKG(kg: KnowledgeGraph): void {
  ensureDocDir(kg.docId);
  const path = kgPath(kg.docId);
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(kg, null, 2));
  fs.renameSync(tmp, path);
}

export function emptyKG(docId: string): KnowledgeGraph {
  return {
    v: 1,
    docId,
    status: "missing",
    buildAt: null,
    lastEvaluatedAt: null,
    evaluationCount: 0,
    nodes: [],
    edges: [],
    globalNote: "",
  };
}
