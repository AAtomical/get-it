"use client";

/**
 * Flashcards.
 *
 * Flow:
 *   1. Pick a topic, or leave it empty for the whole document.
 *   2. Generate a compact active-recall deck.
 *   3. Recall, reveal, then self-grade.
 *   4. End of deck triggers KG evaluation server-side.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Eye,
  Layers,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { FlashcardSession } from "@/lib/work-context-types";
import { consumePrefill } from "./prefill";

type Props = { docId: string };
type Rating = 1 | 2 | 3 | 4;

const RATING_LABELS: Record<
  Rating,
  {
    text: string;
    hint: string;
    tone: string;
    dot: string;
    meter: string;
  }
> = {
   1: {
      text: "Again",
      hint: "Missed recall",
      tone: "border-[var(--feedback-wrong-border)] bg-[var(--feedback-wrong-bg)] text-[var(--feedback-wrong-text)] hover:bg-[var(--feedback-wrong-bg)]",
      dot: "bg-[var(--feedback-wrong-icon)]",
      meter: "bg-[var(--feedback-wrong-icon)]",
    },
    2: {
      text: "Hard",
      hint: "Needs another pass",
      tone: "border-[var(--tag-amber-ring)] bg-[var(--tag-amber-bg)] text-[var(--tag-amber-fg)] hover:bg-[var(--tag-amber-bg)]",
      dot: "bg-[var(--tag-amber-fg)]",
      meter: "bg-[var(--tag-amber-fg)]",
    },
    3: {
      text: "Good",
      hint: "Mostly recalled",
      tone: "border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] text-[var(--feedback-correct-text)] hover:bg-[var(--feedback-correct-bg)]",
      dot: "bg-[var(--feedback-correct-icon)]",
      meter: "bg-[var(--feedback-correct-icon)]",
    },
    4: {
      text: "Easy",
      hint: "Instant recall",
      tone: "border-[var(--tag-sky-ring)] bg-[var(--tag-sky-bg)] text-[var(--tag-sky-fg)] hover:bg-[var(--tag-sky-bg)]",
      dot: "bg-[var(--tag-sky-fg)]",
      meter: "bg-[var(--tag-sky-fg)]",
    },
};

export default function FlashcardsView({ docId }: Props) {
  const [sessions, setSessions] = useState<FlashcardSession[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [userAnswer, setUserAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/flashcards/${docId}`)
      .then((r) => r.json())
      .then((j: { sessions: FlashcardSession[] }) => {
        if (cancelled) return;
        setSessions(j.sessions);
        const prefill = consumePrefill(docId, "flashcards");
        if (prefill) {
          setTopic(prefill);
          return;
        }
        const live = j.sessions.find((s) => !s.endedAt);
        if (live) {
          setActiveId(live.id);
          const firstUnanswered = live.cards.findIndex((c) => c.rating == null);
          const nextIndex =
            firstUnanswered === -1 ? Math.max(0, live.cards.length - 1) : firstUnanswered;
          setCardIndex(nextIndex);
          setRevealed(live.cards[nextIndex]?.rating != null);
          setUserAnswer(live.cards[nextIndex]?.userAnswer ?? "");
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
      const r = await fetch(`/api/flashcards/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate", topic: topic.trim() || "all" }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || `Couldn't generate the deck (${r.status}).`);
      }
      const j = (await r.json()) as { session: FlashcardSession };
      setSessions((prev) => [j.session, ...(prev ?? [])]);
      setActiveId(j.session.id);
      setCardIndex(0);
      setRevealed(false);
      setUserAnswer("");
      setTopic("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [docId, topic]);

  const rate = useCallback(
    async (rating: Rating) => {
      if (!active) return;
      const idx = cardIndex;
      const answer = userAnswer.trim();
      setSessions((prev) =>
        prev
          ? prev.map((s) =>
              s.id === active.id
                ? {
                    ...s,
                    cards: s.cards.map((c, i) =>
                      i === idx ? { ...c, rating, userAnswer: answer || undefined } : c,
                    ),
                  }
                : s,
            )
          : prev,
      );
      try {
        await fetch(`/api/flashcards/${docId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "rate",
            sessionId: active.id,
            cardIndex: idx,
            rating,
            userAnswer: answer || undefined,
          }),
        });
      } catch {
        /* leave optimistic state; next refresh reconciles */
      }

      const nextIdx = idx + 1;
      if (nextIdx >= active.cards.length) {
        try {
          const r = await fetch(`/api/flashcards/${docId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "end", sessionId: active.id }),
          });
          const j = (await r.json()) as { session: FlashcardSession };
          setSessions((prev) =>
            prev ? prev.map((s) => (s.id === active.id ? j.session : s)) : prev,
          );
        } catch {
          /* noop */
        }
      }
      setCardIndex(nextIdx);
      setRevealed(false);
      setUserAnswer(active.cards[nextIdx]?.userAnswer ?? "");
    },
    [active, cardIndex, docId, userAnswer],
  );

  const jumpToCard = useCallback(
    (session: FlashcardSession, index: number) => {
      const bounded = Math.min(Math.max(index, 0), session.cards.length);
      const card = session.cards[bounded];
      setCardIndex(bounded);
      setRevealed(session.endedAt != null || card?.rating != null);
      setUserAnswer(card?.userAnswer ?? "");
    },
    [],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await fetch(`/api/flashcards/${docId}?sessionId=${encodeURIComponent(id)}`, {
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
        <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" /> loading flashcards...
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-canvas)]">
        <div className="m-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2">
          <div className="mb-2 flex items-center gap-1.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--accent-100)] bg-[var(--accent-50)] text-[var(--accent-700)]">
              <Layers className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
                New deck
              </label>
              <p className="truncate text-[10.5px] text-[var(--ink-400)]">Active recall cards</p>
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
                <Sparkles className="h-3.5 w-3.5" /> Generate deck
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
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-[var(--feedback-wrong-border)] bg-[var(--feedback-wrong-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--feedback-wrong-text)] transition hover:opacity-80 disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" /> Retry
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
          <span>Past decks</span>
          <span className="tabular-nums text-[var(--ink-400)]">{sessions.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-[11.5px] leading-relaxed text-[var(--ink-400)]">
              Nothing yet. Generate your first deck above.
            </p>
          ) : (
            sessions.map((s) => (
              <DeckListItem
                key={s.id}
                session={s}
                active={activeId === s.id}
                onSelect={() => {
                  setActiveId(s.id);
                  const firstUnanswered = s.cards.findIndex((c) => c.rating == null);
                  const nextIndex = s.endedAt
                    ? s.cards.length
                    : firstUnanswered === -1
                      ? Math.max(0, s.cards.length - 1)
                      : firstUnanswered;
                  jumpToCard(s, nextIndex);
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
            icon={<Layers className="h-7 w-7 text-[var(--ink-400)]" />}
            text="Pick a topic on the left and generate a deck. Each rating feeds the knowledge graph."
          />
        ) : (
          <CardRunner
            session={active}
            cardIndex={cardIndex}
            revealed={revealed}
            userAnswer={userAnswer}
            onUserAnswer={setUserAnswer}
            onReveal={() => setRevealed(true)}
            onRate={rate}
            onJump={(i) => jumpToCard(active, i)}
          />
        )}
      </section>
    </div>
  );
}

function DeckListItem({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: FlashcardSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const answered = session.cards.filter((c) => c.rating != null).length;
  const total = session.cards.length;
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
            {answered}/{total} cards
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
        complete ? "bg-[var(--feedback-correct-icon)]" : progress > 0 ? "bg-[var(--accent-500)]" : "bg-[var(--ink-300)]"
      }`}
      title={complete ? "Deck complete" : progress > 0 ? "In progress" : "Not started"}
    />
  );
}

function CardRunner({
  session,
  cardIndex,
  revealed,
  userAnswer,
  onUserAnswer,
  onReveal,
  onRate,
  onJump,
}: {
  session: FlashcardSession;
  cardIndex: number;
  revealed: boolean;
  userAnswer: string;
  onUserAnswer: (s: string) => void;
  onReveal: () => void;
  onRate: (r: Rating) => void;
  onJump: (i: number) => void;
}) {
  const total = session.cards.length;
  const answeredCount = session.cards.filter((c) => c.rating != null).length;
  const progress = total > 0 ? (answeredCount / total) * 100 : 0;
  const done = total === 0 || cardIndex >= total;
  const safeIndex = total > 0 ? Math.min(Math.max(cardIndex, 0), total - 1) : 0;
  const card = session.cards[safeIndex];
  const rating = card?.rating;
  const readOnly = session.endedAt != null || rating != null;
  const shownAnswer = userAnswer || card?.userAnswer || "";
  const title = session.topic === "all" ? "Whole document" : session.topic;

  if (done) {
    return <DeckComplete session={session} onJump={onJump} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-5 py-2.5">
        <div className="mb-2 flex items-center justify-between gap-3 text-[11.5px] text-[var(--ink-500)]">
          <span className="flex min-w-0 items-center gap-2">
            <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--accent-600)]" />
            <span className="truncate">
              {title}
            </span>
          </span>
          <span className="shrink-0 tabular-nums">
            {answeredCount}/{total} complete
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
              <span className="tabular-nums">Card {safeIndex + 1}</span>
              <span className="text-[var(--ink-300)]">/</span>
              <span className="tabular-nums text-[var(--ink-500)]">{total}</span>
            </div>
            {rating != null && <RatingBadge rating={rating} />}
          </div>

          <FlashcardStack
            question={card.q}
            answer={card.a}
            revealed={revealed}
            cardNumber={safeIndex + 1}
          />

          {!readOnly && (
            <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
                <PencilLine className="h-3.5 w-3.5" />
                Recall pad
              </div>
              <textarea
                value={userAnswer}
                onChange={(e) => onUserAnswer(e.target.value)}
                placeholder="Type your answer before revealing it..."
                rows={3}
                disabled={revealed}
                className="min-h-[76px] w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ink-900)] placeholder:text-[var(--ink-400)] focus:border-[var(--accent-500)] focus:outline-none disabled:bg-[var(--surface-sunken)]"
              />
            </div>
          )}

          {readOnly && shownAnswer && (
            <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-canvas)] px-3 py-2">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
                Your answer
              </p>
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--ink-700)]">
                {shownAnswer}
              </p>
            </div>
          )}

          {!revealed ? (
            <button
              type="button"
              onClick={onReveal}
              className="self-center inline-flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-4 py-2 text-[12.5px] font-medium text-white hover:bg-[var(--button-primary-hover)]"
            >
              <Eye className="h-3.5 w-3.5" /> Reveal answer
            </button>
          ) : rating == null && !session.endedAt ? (
            <RatingControls onRate={onRate} />
          ) : (
            <div className="flex items-center justify-center gap-2 text-[11.5px] text-[var(--ink-500)]">
              <span>This card is saved.</span>
              <button
                type="button"
                className="font-medium text-[var(--ink-700)] underline underline-offset-2 hover:text-[var(--ink-900)]"
                onClick={() => onJump(safeIndex + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FlashcardStack({
  question,
  answer,
  revealed,
  cardNumber,
}: {
  question: string;
  answer: string;
  revealed: boolean;
  cardNumber: number;
}) {
  return (
    <div className="relative px-2 pb-2 pt-1">
      <div className="absolute inset-x-8 top-4 h-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)]" />
      <div className="absolute inset-x-5 top-2 h-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)]" />
      <div className="relative [perspective:1400px]">
        <div
          className={`relative h-[min(42vh,320px)] min-h-[250px] transition-transform duration-500 [transform-style:preserve-3d] ${
            revealed ? "[transform:rotateY(180deg)]" : ""
          }`}
        >
          <FlashcardFace
            label="Question"
            kicker={`Card ${cardNumber}`}
            text={question}
            accent="border-[var(--accent-100)] bg-[var(--accent-50)] text-[var(--accent-700)]"
            className="[backface-visibility:hidden]"
          />
          <FlashcardFace
            label="Answer"
            kicker="Reveal"
            text={answer}
            accent="border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] text-[var(--feedback-correct-text)]"
            className="absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]"
          />
        </div>
      </div>
    </div>
  );
}

function FlashcardFace({
  label,
  kicker,
  text,
  accent,
  className,
}: {
  label: string;
  kicker: string;
  text: string;
  accent: string;
  className?: string;
}) {
  return (
    <div
      className={`flex h-full flex-col rounded-lg border border-[var(--border-default)] bg-[var(--surface-raised)] shadow-[var(--shadow-popover)] ${className ?? ""}`}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold ${accent}`}>
          {label === "Answer" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Layers className="h-3.5 w-3.5" />}
          {label}
        </span>
        <span className="text-[11px] font-medium text-[var(--ink-400)]">{kicker}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <p className="whitespace-pre-wrap text-[16px] leading-relaxed text-[var(--ink-900)]">
          {text}
        </p>
      </div>
    </div>
  );
}

function RatingControls({ onRate }: { onRate: (r: Rating) => void }) {
  return (
    <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3">
      <p className="mb-2 text-center text-[11.5px] font-medium text-[var(--ink-500)]">
        How well did you recall it?
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([1, 2, 3, 4] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onRate(r)}
            className={`flex min-h-[58px] flex-col items-start justify-center rounded-md border px-3 py-2 text-left transition-colors ${RATING_LABELS[r].tone}`}
          >
            <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
              <RatingIcon rating={r} />
              {RATING_LABELS[r].text}
            </span>
            <span className="mt-0.5 text-[10.5px] opacity-75">{RATING_LABELS[r].hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RatingIcon({ rating }: { rating: Rating }) {
  if (rating === 1) return <RotateCcw className="h-3.5 w-3.5" />;
  if (rating === 2) return <AlertCircle className="h-3.5 w-3.5" />;
  if (rating === 3) return <Check className="h-3.5 w-3.5" />;
  return <Sparkles className="h-3.5 w-3.5" />;
}

function RatingBadge({ rating }: { rating: Rating }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium ${RATING_LABELS[rating].tone}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${RATING_LABELS[rating].dot}`} />
      {RATING_LABELS[rating].text}
    </span>
  );
}

function DeckComplete({
  session,
  onJump,
}: {
  session: FlashcardSession;
  onJump: (i: number) => void;
}) {
  const stats = useMemo(() => {
    const counts: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const answered = session.cards.filter((c) => c.rating != null);
    for (const card of answered) counts[card.rating as Rating] += 1;
    const avg =
      answered.length > 0
        ? answered.reduce((sum, card) => sum + (card.rating ?? 0), 0) / answered.length
        : 0;
    return { counts, answered, avg };
  }, [session.cards]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-8 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] text-[var(--feedback-correct-icon)]">
        <CheckCircle2 className="h-5 w-5" />
      </div>
      <p className="text-[15px] font-semibold text-[var(--ink-900)]">Deck complete</p>
      <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-[var(--ink-500)]">
        Average self-grade {stats.avg.toFixed(1)}/4 across {stats.answered.length} cards.
        The knowledge graph is updating in the background.
      </p>

      <div className="mt-5 w-full max-w-md rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3">
        <div className="mb-3 flex items-center justify-between text-[11.5px] text-[var(--ink-500)]">
          <span>Recall profile</span>
          <span>{stats.answered.length}/{session.cards.length}</span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {([1, 2, 3, 4] as const).map((rating) => {
            const value = stats.counts[rating];
            const height = stats.answered.length > 0 ? Math.max(8, (value / stats.answered.length) * 52) : 8;
            return (
              <div key={rating} className="flex flex-col items-center gap-1">
                <div className="flex h-14 w-full items-end rounded bg-[var(--surface-sunken)] px-1">
                  <div
                    className={`w-full rounded-t ${RATING_LABELS[rating].meter}`}
                    style={{ height }}
                  />
                </div>
                <span className="text-[10.5px] font-medium text-[var(--ink-500)]">
                  {RATING_LABELS[rating].text}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex max-w-md flex-wrap justify-center gap-1.5">
        {session.cards.map((c, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onJump(i)}
            className={`h-7 w-7 rounded-md border text-[11px] font-medium ${
              c.rating != null
                ? RATING_LABELS[c.rating].tone
                : "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--ink-500)]"
            }`}
            title={`Card ${i + 1}`}
          >
            {i + 1}
          </button>
        ))}
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
