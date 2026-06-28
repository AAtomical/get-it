"use client";

/**
 * Quizzes.
 *
 * Flow (mirrors flashcards):
 *   1. Pick a topic, or leave it empty for the whole document.
 *   2. Generate a compact multiple-choice quiz (4–8 questions, 4 options each).
 *   3. Answer one question at a time — immediate right/wrong feedback +
 *      one-sentence explanation.
 *   4. The final question rolls into a score summary; ending the session
 *      triggers a KG evaluation pass.
 *
 * The UI deliberately echoes FlashcardsView so the two tools feel like
 * siblings — same sidebar form, same past-sessions list, same progress
 * bar and end-of-deck summary. The interaction is different (forced
 * choice vs. open recall), so the centre column swaps the recall pad +
 * Reveal flow for option buttons + correct/incorrect feedback.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ListChecks,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { QuizQuestion, QuizSession } from "@/lib/work-context-types";
import { consumePrefill } from "./prefill";

type Props = { docId: string };

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

export default function QuizzesView({ docId }: Props) {
  const [sessions, setSessions] = useState<QuizSession[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [qIndex, setQIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/quizzes/${docId}`)
      .then((r) => r.json())
      .then((j: { sessions: QuizSession[] }) => {
        if (cancelled) return;
        setSessions(j.sessions);
        const prefill = consumePrefill(docId, "quizzes");
        if (prefill) {
          setTopic(prefill);
          return;
        }
        const live = j.sessions.find((s) => !s.endedAt);
        if (live) {
          setActiveId(live.id);
          const firstUnanswered = live.questions.findIndex((q) => q.chosenIndex == null);
          setQIndex(firstUnanswered === -1 ? Math.max(0, live.questions.length - 1) : firstUnanswered);
        }
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const active = sessions?.find((s) => s.id === activeId) ?? null;

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const r = await fetch(`/api/quizzes/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate", topic: topic.trim() || "all" }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || `Couldn't generate the quiz (${r.status}).`);
      }
      const j = (await r.json()) as { session: QuizSession };
      setSessions((prev) => [j.session, ...(prev ?? [])]);
      setActiveId(j.session.id);
      setQIndex(0);
      setTopic("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [docId, topic]);

  const answer = useCallback(
    async (chosenIndex: number) => {
      if (!active) return;
      const idx = qIndex;
      const question = active.questions[idx];
      if (!question || question.chosenIndex != null) return;
      // Optimistic update — the server is the source of truth but the UI
      // mustn't wait on the round-trip to colour the chosen option.
      setSessions((prev) =>
        prev
          ? prev.map((s) =>
              s.id === active.id
                ? {
                    ...s,
                    questions: s.questions.map((q, i) =>
                      i === idx ? { ...q, chosenIndex, answeredAt: Date.now() } : q,
                    ),
                  }
                : s,
            )
          : prev,
      );
      try {
        await fetch(`/api/quizzes/${docId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "answer",
            sessionId: active.id,
            questionIndex: idx,
            chosenIndex,
          }),
        });
      } catch {
        /* leave optimistic state; the next refresh reconciles */
      }
    },
    [active, qIndex, docId],
  );

  const nextQuestion = useCallback(async () => {
    if (!active) return;
    const nextIdx = qIndex + 1;
    if (nextIdx < active.questions.length) {
      setQIndex(nextIdx);
      return;
    }
    // Last question answered — end session and surface the summary.
    try {
      const r = await fetch(`/api/quizzes/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "end", sessionId: active.id }),
      });
      const j = (await r.json()) as { session: QuizSession };
      setSessions((prev) => (prev ? prev.map((s) => (s.id === active.id ? j.session : s)) : prev));
    } catch {
      /* noop */
    }
    setQIndex(active.questions.length);
  }, [active, qIndex, docId]);

  const jumpToQuestion = useCallback((session: QuizSession, index: number) => {
    const bounded = Math.min(Math.max(index, 0), session.questions.length);
    setQIndex(bounded);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      await fetch(`/api/quizzes/${docId}?sessionId=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
      if (activeId === id) setActiveId(null);
    },
    [activeId, docId],
  );

  if (sessions === null) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-[var(--ink-500)]">
        <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" /> loading quizzes...
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-canvas)]">
        <div className="m-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2">
          <div className="mb-2 flex items-center gap-1.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--accent-100)] bg-[var(--accent-50)] text-[var(--accent-700)]">
              <ListChecks className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
                New quiz
              </label>
              <p className="truncate text-[10.5px] text-[var(--ink-400)]">Multiple-choice questions</p>
            </div>
          </div>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic, or whole doc"
            className="mb-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px] text-[var(--ink-900)] placeholder:text-[var(--ink-400)] focus:border-[var(--accent-500)] focus:outline-none"
            disabled={generating}
          />
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] py-1.5 text-[12px] font-medium text-white hover:bg-[var(--button-primary-hover)] disabled:opacity-50"
          >
            {generating ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> generating...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" /> Generate quiz
              </>
            )}
          </button>
          {error && (
            <div className="mt-2">
              <p className="text-[11px] leading-relaxed text-rose-700">{error}</p>
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" /> Retry
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
          <span>Past quizzes</span>
          <span className="tabular-nums text-[var(--ink-400)]">{sessions.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-[11.5px] leading-relaxed text-[var(--ink-400)]">
              Nothing yet. Generate your first quiz above.
            </p>
          ) : (
            sessions.map((s) => (
              <QuizListItem
                key={s.id}
                session={s}
                active={activeId === s.id}
                onSelect={() => {
                  setActiveId(s.id);
                  const firstUnanswered = s.questions.findIndex((q) => q.chosenIndex == null);
                  const nextIndex = s.endedAt
                    ? s.questions.length
                    : firstUnanswered === -1
                      ? Math.max(0, s.questions.length - 1)
                      : firstUnanswered;
                  jumpToQuestion(s, nextIndex);
                }}
                onDelete={() => deleteSession(s.id)}
              />
            ))
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[var(--surface-raised)]">
        {!active ? (
          <EmptyHint
            icon={<ListChecks className="h-7 w-7 text-[var(--ink-400)]" />}
            text="Pick a topic on the left and generate a quiz. Each answer feeds the knowledge graph."
          />
        ) : (
          <QuizRunner
            session={active}
            qIndex={qIndex}
            onAnswer={answer}
            onNext={nextQuestion}
            onJump={(i) => jumpToQuestion(active, i)}
          />
        )}
      </section>
    </div>
  );
}

function QuizListItem({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: QuizSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const answered = session.questions.filter((q) => q.chosenIndex != null).length;
  const total = session.questions.length;
  const progress = total > 0 ? (answered / total) * 100 : 0;
  const title = session.topic === "all" ? "Whole document" : session.topic;

  return (
    <div
      className={`group mb-1 rounded-md px-2 py-1.5 text-[11.5px] transition-colors ${
        active
          ? "bg-[var(--surface-raised)] text-[var(--ink-900)] shadow-[var(--shadow-nav)]"
          : "text-[var(--ink-700)] hover:bg-[var(--surface-sunken)]"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 truncate text-left font-medium"
          title={title}
        >
          {title}
        </button>
        <StatusDot ended={session.endedAt != null} progress={progress} />
        <button
          type="button"
          onClick={onDelete}
          className="invisible flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--ink-400)] hover:bg-[var(--surface-sunken)] hover:text-rose-600 group-hover:visible"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <button type="button" onClick={onSelect} className="mt-1 block w-full text-left">
        <div className="mb-1 flex items-center justify-between text-[10.5px] text-[var(--ink-400)]">
          <span>
            {answered}/{total} questions
          </span>
          <span>{session.endedAt ? "done" : "in progress"}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
          <div
            className="h-full rounded-full bg-[var(--accent-500)] transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </button>
    </div>
  );
}

function StatusDot({ ended, progress }: { ended: boolean; progress: number }) {
  const complete = ended || progress >= 100;
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${
        complete ? "bg-emerald-500" : progress > 0 ? "bg-[var(--accent-500)]" : "bg-[var(--ink-300)]"
      }`}
      title={complete ? "Quiz complete" : progress > 0 ? "In progress" : "Not started"}
    />
  );
}

function QuizRunner({
  session,
  qIndex,
  onAnswer,
  onNext,
  onJump,
}: {
  session: QuizSession;
  qIndex: number;
  onAnswer: (chosenIndex: number) => void;
  onNext: () => void;
  onJump: (i: number) => void;
}) {
  const total = session.questions.length;
  const answeredCount = session.questions.filter((q) => q.chosenIndex != null).length;
  const progress = total > 0 ? (answeredCount / total) * 100 : 0;
  const done = total === 0 || qIndex >= total;
  const safeIndex = total > 0 ? Math.min(Math.max(qIndex, 0), total - 1) : 0;
  const question = session.questions[safeIndex];
  const title = session.topic === "all" ? "Whole document" : session.topic;

  if (done) {
    return <QuizComplete session={session} onJump={onJump} />;
  }

  const picked = question.chosenIndex;
  const revealed = picked != null;
  const isLast = safeIndex === total - 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-5 py-2.5">
        <div className="mb-2 flex items-center justify-between gap-3 text-[11.5px] text-[var(--ink-500)]">
          <span className="flex min-w-0 items-center gap-2">
            <ListChecks className="h-3.5 w-3.5 shrink-0 text-[var(--accent-600)]" />
            <span className="truncate">{title}</span>
          </span>
          <span className="shrink-0 tabular-nums">
            {answeredCount}/{total} answered
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
          <div
            className="h-full rounded-full bg-[var(--accent-500)] transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <div className="flex items-center justify-between gap-3 text-[11.5px]">
            <div className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 font-medium text-[var(--ink-700)]">
              <span className="tabular-nums">Question {safeIndex + 1}</span>
              <span className="text-[var(--ink-300)]">/</span>
              <span className="tabular-nums text-[var(--ink-500)]">{total}</span>
            </div>
            {revealed && (
              <VerdictBadge correct={picked === question.correctIndex} />
            )}
          </div>

          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-raised)] px-5 py-4 shadow-[var(--shadow-nav)]">
            <p className="whitespace-pre-wrap text-[15.5px] leading-relaxed text-[var(--ink-900)]">
              {question.stem}
            </p>
          </div>

          <OptionList
            question={question}
            picked={picked}
            onPick={onAnswer}
          />

          {revealed && (
            <ExplanationCard
              correct={picked === question.correctIndex}
              correctOption={question.options[question.correctIndex]}
              explanation={question.explanation}
            />
          )}

          {revealed && (
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={onNext}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-4 py-2 text-[12.5px] font-medium text-white hover:bg-[var(--button-primary-hover)]"
              >
                {isLast ? "Finish quiz" : "Next question"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OptionList({
  question,
  picked,
  onPick,
}: {
  question: QuizQuestion;
  picked: number | undefined;
  onPick: (i: number) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2">
      {question.options.map((opt, i) => {
        const revealed = picked != null;
        const isPicked = picked === i;
        const isCorrect = i === question.correctIndex;
        let tone =
          "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--ink-900)] hover:bg-[var(--surface-sunken)]";
        let labelTone =
          "border-[var(--border-subtle)] bg-[var(--surface-canvas)] text-[var(--ink-500)]";
        let trailing: ReactNode = null;
        if (revealed) {
          if (isCorrect) {
            tone =
              "border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] text-[var(--feedback-correct-text)]";
            labelTone = "border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] text-[var(--feedback-correct-text)]";
            trailing = <CheckCircle2 className="h-4 w-4 text-[var(--feedback-correct-icon)]" />;
          } else if (isPicked) {
            tone = "border-[var(--feedback-wrong-border)] bg-[var(--feedback-wrong-bg)] text-[var(--feedback-wrong-text)]";
            labelTone = "border-[var(--feedback-wrong-border)] bg-[var(--feedback-wrong-bg)] text-[var(--feedback-wrong-text)]";
            trailing = <X className="h-4 w-4 text-[var(--feedback-wrong-icon)]" />;
          } else {
            tone =
              "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--ink-500)] opacity-70";
          }
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => onPick(i)}
            disabled={revealed}
            className={`flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors disabled:cursor-default ${tone}`}
            aria-pressed={isPicked}
          >
            <span
              className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold ${labelTone}`}
            >
              {OPTION_LABELS[i]}
            </span>
            <span className="flex-1 whitespace-pre-wrap text-[13.5px] leading-relaxed">{opt}</span>
            {trailing && <span className="mt-0.5 shrink-0">{trailing}</span>}
          </button>
        );
      })}
    </div>
  );
}

function VerdictBadge({ correct }: { correct: boolean }) {
  return correct ? (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] px-2 py-1 text-[11px] font-medium text-[var(--feedback-correct-text)]">
      <Check className="h-3.5 w-3.5" /> Correct
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--feedback-wrong-border)] bg-[var(--feedback-wrong-bg)] px-2 py-1 text-[11px] font-medium text-[var(--feedback-wrong-text)]">
      <AlertCircle className="h-3.5 w-3.5" /> Not quite
    </span>
  );
}

function ExplanationCard({
  correct,
  correctOption,
  explanation,
}: {
  correct: boolean;
  correctOption: string;
  explanation: string;
}) {
  return (
    <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-canvas)] px-4 py-3">
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
        {correct ? "Why this is right" : "The right answer was"}
      </p>
      {!correct && (
        <p className="mb-1 whitespace-pre-wrap text-[13px] font-medium leading-relaxed text-[var(--feedback-correct-text)]">
          {correctOption}
        </p>
      )}
      <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--ink-700)]">
        {explanation}
      </p>
    </div>
  );
}

function QuizComplete({
  session,
  onJump,
}: {
  session: QuizSession;
  onJump: (i: number) => void;
}) {
  const stats = useMemo(() => {
    const answered = session.questions.filter((q) => q.chosenIndex != null);
    const correct = answered.filter((q) => q.chosenIndex === q.correctIndex).length;
    const total = session.questions.length;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    return { answered, correct, total, pct };
  }, [session.questions]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-8 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] text-[var(--feedback-correct-icon)]">
        <CheckCircle2 className="h-5 w-5" />
      </div>
      <p className="text-[15px] font-semibold text-[var(--ink-900)]">Quiz complete</p>
      <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-[var(--ink-500)]">
        Scored {stats.correct}/{stats.total} ({stats.pct}%) across {stats.answered.length} answered
        questions. The knowledge graph is updating in the background.
      </p>

      <div className="mt-5 w-full max-w-md rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3">
        <div className="mb-3 flex items-center justify-between text-[11.5px] text-[var(--ink-500)]">
          <span>Per-question result</span>
          <span>
            {stats.correct}/{stats.total} correct
          </span>
        </div>
        <div className="flex max-w-md flex-wrap justify-center gap-1.5">
          {session.questions.map((q, i) => {
            const answered = q.chosenIndex != null;
            const correct = answered && q.chosenIndex === q.correctIndex;
            const tone = !answered
              ? "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--ink-500)]"
              : correct
              ? "border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] text-[var(--feedback-correct-text)]"
              : "border-[var(--feedback-wrong-border)] bg-[var(--feedback-wrong-bg)] text-[var(--feedback-wrong-text)]";
            return (
              <button
                key={i}
                type="button"
                onClick={() => onJump(i)}
                className={`h-7 w-7 rounded-md border text-[11px] font-medium ${tone}`}
                title={`Question ${i + 1}`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EmptyHint({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-8 text-center">
      <div className="max-w-sm">
        <div className="mb-3 flex justify-center">{icon}</div>
        <p className="text-[13.5px] leading-relaxed text-[var(--ink-500)]">{text}</p>
      </div>
    </div>
  );
}
