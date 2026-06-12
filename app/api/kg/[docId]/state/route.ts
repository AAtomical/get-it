/**
 * GET /api/kg/[docId]/state — fetch the current knowledge graph for a doc.
 *
 * Returns 200 with status="missing" if the graph hasn't been built yet, so
 * the client can render the empty state without hitting an HTTP error path.
 */

import { NextResponse } from "next/server";
import { emptyKG, loadKG, saveKG } from "@/lib/kg";
import { getDoc } from "@/lib/store";
import { isEvaluating, isBuilding } from "@/lib/kg-runner";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  
  const kg = loadKG(docId) ?? emptyKG(docId);
  
  // If the graph is marked as building on disk but no process is actually building it 
  // (e.g. because the server restarted or HMR reloaded the process), revert it to error
  // so the client can show the retry button instead of spinning forever.
  if (kg.status === "building" && !isBuilding(docId)) {
    kg.status = "error";
    kg.buildError = "Build was interrupted by a server restart. Please try again.";
    saveKG(kg);
  }
  
  return NextResponse.json({ ...kg, evaluating: isEvaluating(docId) });
}
