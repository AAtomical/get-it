/**
 * POST /api/jobs/viz/[docId]
 *   body: { tagId: string, runtimeError?: string }
 *         | { retryFailed: true }  — re-queue every tag currently in error
 *
 * Marks a tag as needing (re)generation server-side and kicks the viz
 * queue. If runtimeError is set, the queue tries to repair the broken
 * spec with the error as repair context — respecting the per-tag
 * retry budget (settings.maxRetries).
 *
 * Fire-and-forget from the renderer's POV: the queue runs in the
 * background and the viewer polls /api/tags/<docId> to see progress.
 */

import { NextResponse } from "next/server";
import { getDoc } from "@/lib/store";
import {
  requestVizGeneration,
  requestRetryFailedViz,
  isVizQueueRunning,
} from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  let body: { tagId?: string; runtimeError?: string; retryFailed?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.retryFailed === true) {
    const requeued = requestRetryFailedViz(docId);
    return NextResponse.json({
      ok: true,
      requeued,
      queueRunning: isVizQueueRunning(docId),
    });
  }
  if (!body.tagId || typeof body.tagId !== "string") {
    return NextResponse.json({ error: "tagId required" }, { status: 400 });
  }
  requestVizGeneration(docId, body.tagId, body.runtimeError);
  return NextResponse.json({ ok: true, queueRunning: isVizQueueRunning(docId) });
}
