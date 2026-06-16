/**
 * Server-side persistence for the work context.
 *
 * Pure types live in lib/work-context-types.ts so client components can
 * import them without pulling node:fs into the browser bundle.
 *
 * One file per docId at <DATA_DIR>/docs/<docId>/workctx.json (see lib/paths.ts).
 * Tools append to it; the evaluator never mutates it. Append-only by
 * convention.
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureDocDir, workCtxPath } from "./paths";
import type { WorkContext } from "./work-context-types";

export type {
  ChatMessage,
  ChatThread,
  Flashcard,
  FlashcardSession,
  FeynmanTurn,
  FeynmanSession,
  QuizQuestion,
  QuizSession,
  WorkContext,
} from "./work-context-types";

export function loadWorkContext(docId: string): WorkContext {
  try {
    const raw = fs.readFileSync(workCtxPath(docId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<WorkContext> & { v?: number };
    if (parsed && parsed.v === 1) {
      // Back-fill arrays that were added after a doc's first save so
      // pre-existing journals load cleanly into the new shape.
      return {
        v: 1,
        docId: parsed.docId ?? docId,
        chats: parsed.chats ?? [],
        flashcards: parsed.flashcards ?? [],
        quizzes: parsed.quizzes ?? [],
        feynman: parsed.feynman ?? [],
      };
    }
  } catch {
    /* file missing or malformed — start fresh */
  }
  return { v: 1, docId, chats: [], flashcards: [], quizzes: [], feynman: [] };
}

export function saveWorkContext(ctx: WorkContext): void {
  ensureDocDir(ctx.docId);
  const path = workCtxPath(ctx.docId);
  const tmp = `${path}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ctx, null, 2));
  fs.renameSync(tmp, path);
}

export function newId(): string {
  return randomUUID();
}

/**
 * Is there any interaction newer than `sinceTs`? Used to skip an evaluation
 * pass entirely when nothing has changed since the last one — so a redundant
 * trigger (e.g. flipping tools without studying) costs zero Codex calls.
 * `sinceTs == null` (first ever evaluation) counts everything as new.
 */
export function hasInteractionsSince(ctx: WorkContext, sinceTs: number | null): boolean {
  const fresh = (ts: number | undefined | null) =>
    ts != null && (sinceTs == null || ts > sinceTs);
  for (const c of ctx.chats) if (c.messages.some((m) => fresh(m.ts))) return true;
  for (const s of ctx.flashcards) if (s.cards.some((card) => fresh(card.answeredAt))) return true;
  for (const s of ctx.quizzes) if (s.questions.some((q) => fresh(q.answeredAt))) return true;
  for (const s of ctx.feynman) {
    if (s.turns.some((t) => fresh(t.ts))) return true;
    if (fresh(s.endedAt)) return true;
  }
  return false;
}

/**
 * Compact, evaluator-friendly summary of the work context. We strip
 * boilerplate (role labels become inline prefixes) and trim long messages
 * so the prompt stays bounded even after months of use. The full file is
 * still on disk for inspection.
 *
 * When `sinceTs` is provided, only interactions newer than it are emitted —
 * the evaluator already receives every node's CURRENT score as the baseline,
 * so it only needs the fresh evidence to decide where to raise scores. This
 * keeps each pass cheap regardless of total history, with no loss of quality
 * (scores are monotone, so prior evidence is preserved in the baseline).
 * `sinceTs == null` emits the full history (used for the first evaluation).
 */
export function summariseForEvaluator(
  ctx: WorkContext,
  sinceTs: number | null = null,
): string {
  const fresh = (ts: number | undefined | null) =>
    ts != null && (sinceTs == null || ts > sinceTs);
  const incremental = sinceTs != null;
  const lines: string[] = [];

  // Chats — only messages newer than the last evaluation.
  const chatBlocks: string[] = [];
  for (const c of ctx.chats) {
    const msgs = incremental ? c.messages.filter((m) => fresh(m.ts)) : c.messages;
    if (!msgs.length) continue;
    chatBlocks.push(`\n## chat "${c.title}" (id=${c.id}, ${msgs.length} new msgs)`);
    for (const m of msgs) {
      const ts = new Date(m.ts).toISOString();
      const text = m.content.length > 600 ? m.content.slice(0, 600) + "…" : m.content;
      chatBlocks.push(`- [${ts}] ${m.role}: ${text}`);
    }
  }
  if (chatBlocks.length) lines.push("# CHATS", ...chatBlocks);

  // Flashcards — only cards answered since the last evaluation.
  const fcBlocks: string[] = [];
  for (const s of ctx.flashcards) {
    const cards = incremental ? s.cards.filter((card) => fresh(card.answeredAt)) : s.cards;
    if (!cards.length) continue;
    const status = s.endedAt ? "ended" : "in-progress";
    fcBlocks.push(`\n## deck "${s.topic}" (id=${s.id}, ${status}, ${cards.length} graded)`);
    for (const card of cards) {
      const r = card.rating ?? "—";
      const ua = card.userAnswer ? ` user="${card.userAnswer.slice(0, 200)}"` : "";
      fcBlocks.push(`- Q: ${card.q.slice(0, 200)} | A: ${card.a.slice(0, 200)} | rating=${r}${ua}`);
    }
  }
  if (fcBlocks.length) lines.push("\n# FLASHCARDS", ...fcBlocks);

  // Quizzes — only questions answered since the last evaluation.
  const qzBlocks: string[] = [];
  for (const s of ctx.quizzes) {
    const questions = incremental
      ? s.questions.filter((q) => fresh(q.answeredAt))
      : s.questions;
    if (!questions.length) continue;
    const status = s.endedAt ? "ended" : "in-progress";
    const correct = questions.filter(
      (q) => q.chosenIndex != null && q.chosenIndex === q.correctIndex,
    ).length;
    qzBlocks.push(
      `\n## quiz "${s.topic}" (id=${s.id}, ${status}, ${questions.length} answered, ${correct} correct)`,
    );
    for (const q of questions) {
      const picked = q.chosenIndex != null ? q.options[q.chosenIndex] : null;
      const right = q.options[q.correctIndex];
      const verdict =
        q.chosenIndex == null
          ? "unanswered"
          : q.chosenIndex === q.correctIndex
            ? "correct"
            : "incorrect";
      qzBlocks.push(`- Q: ${q.stem.slice(0, 240)}`);
      qzBlocks.push(`  correct: ${right.slice(0, 160)}`);
      qzBlocks.push(
        `  student: ${picked ? picked.slice(0, 160) : "(no answer)"} → ${verdict}`,
      );
    }
  }
  if (qzBlocks.length) lines.push("\n# QUIZZES", ...qzBlocks);

  // Feynman — sessions with new turns, or that ended, since the last pass.
  const fmBlocks: string[] = [];
  for (const s of ctx.feynman) {
    const turns = incremental ? s.turns.filter((t) => fresh(t.ts)) : s.turns;
    const endedNow = fresh(s.endedAt);
    if (!turns.length && !endedNow) continue;
    const status = s.endedAt ? "ended" : "in-progress";
    fmBlocks.push(`\n## feynman "${s.topic}" (id=${s.id}, ${status})`);
    for (const t of turns) {
      fmBlocks.push(`- child: ${t.childPrompt.slice(0, 240)}`);
      fmBlocks.push(`  user: ${t.userExplanation.slice(0, 600)}`);
    }
    if (s.summary && endedNow) fmBlocks.push(`  summary: ${s.summary.slice(0, 400)}`);
  }
  if (fmBlocks.length) lines.push("\n# FEYNMAN", ...fmBlocks);

  if (!lines.length) return incremental ? "(no new interactions)" : "(no interactions yet)";
  return lines.join("\n");
}
