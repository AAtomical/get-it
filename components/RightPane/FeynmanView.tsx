"use client";

/**
 * Feynman method — voice mode.
 *
 * The agent reads the child prompt aloud (TTS); the student answers by
 * speaking. The orb visualizes voice peaks while listening and a soft
 * pulse while the agent is talking. The transcript and history are still
 * rendered as text so the conversation is reviewable.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BookOpenCheck,
  CheckCircle2,
  Lightbulb,
  RefreshCw,
  Sparkles,
  Trash2,
  Volume2,
} from "lucide-react";
import type { FeynmanSession } from "@/lib/work-context-types";
import { consumePrefill } from "./prefill";
import VoiceBlob, { type BlobState } from "./VoiceBlob";

type Props = { docId: string };

type StartResp = {
  session: FeynmanSession;
  childPrompt: string;
  done: false;
  maxTurns: number;
};
type ExplainResp =
  | { session: FeynmanSession; childPrompt: string; done: false; maxTurns: number }
  | { session: FeynmanSession; done: true; summary: string; maxTurns: number };

export default function FeynmanView({ docId }: Props) {
  const [sessions, setSessions] = useState<FeynmanSession[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [pendingChildPrompt, setPendingChildPrompt] = useState<string | null>(null);
  const [pendingBySession, setPendingBySession] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxTurns, setMaxTurns] = useState(4);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/feynman/${docId}`)
      .then((r) => r.json())
      .then((j: { sessions: FeynmanSession[]; maxTurns: number }) => {
        if (cancelled) return;
        setSessions(j.sessions);
        setMaxTurns(j.maxTurns);
        const prefill = consumePrefill(docId, "feynman");
        if (prefill) setTopic(prefill);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const active = sessions?.find((s) => s.id === activeId) ?? null;

  const start = useCallback(async () => {
    // Empty topic is allowed — the server falls back to the whole document.
    const t = topic.trim() || "all";
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try {
        const warm = new SpeechSynthesisUtterance(" ");
        warm.volume = 0;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(warm);
      } catch {
        // ignore
      }
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/feynman/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", topic: t }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || `Couldn't start the session (${r.status}).`);
      }
      const j = (await r.json()) as StartResp;
      setSessions((prev) => [j.session, ...(prev ?? [])]);
      setActiveId(j.session.id);
      setPendingChildPrompt(j.childPrompt);
      setPendingBySession((prev) => ({ ...prev, [j.session.id]: j.childPrompt }));
      setMaxTurns(j.maxTurns);
      setTopic("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [docId, topic]);

  const submitExplanation = useCallback(
    async (text: string) => {
      if (!active || !pendingChildPrompt) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      setBusy(true);
      setError(null);
      const sessionId = active.id;
      const usedPrompt = pendingChildPrompt;
      const optimisticTs = Date.now();
      setSessions((prev) =>
        prev
          ? prev.map((s) =>
              s.id === sessionId
                ? {
                    ...s,
                    turns: [
                      ...s.turns,
                      { childPrompt: usedPrompt, userExplanation: trimmed, ts: optimisticTs },
                    ],
                  }
                : s,
            )
          : prev,
      );
      setPendingChildPrompt(null);
      setPendingBySession((prev) => ({ ...prev, [sessionId]: null }));
      try {
        const r = await fetch(`/api/feynman/${docId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "explain",
            sessionId,
            userExplanation: trimmed,
            childPrompt: usedPrompt,
          }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error || `Couldn't continue the session (${r.status}).`);
        }
        const j = (await r.json()) as ExplainResp;
        setSessions((prev) =>
          prev ? prev.map((s) => (s.id === sessionId ? j.session : s)) : prev,
        );
        if (j.done) {
          setPendingBySession((prev) => ({ ...prev, [sessionId]: null }));
        } else {
          setPendingChildPrompt(j.childPrompt);
          setPendingBySession((prev) => ({ ...prev, [sessionId]: j.childPrompt }));
        }
      } catch (e) {
        // The server didn't persist this turn (it commits only after codex
        // succeeds), so roll the optimistic turn back and restore the prompt
        // the student was answering — they can re-submit to retry cleanly.
        setSessions((prev) =>
          prev
            ? prev.map((s) =>
                s.id === sessionId
                  ? { ...s, turns: s.turns.filter((t) => t.ts !== optimisticTs) }
                  : s,
              )
            : prev,
        );
        setPendingChildPrompt(usedPrompt);
        setPendingBySession((prev) => ({ ...prev, [sessionId]: usedPrompt }));
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [active, docId, pendingChildPrompt],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await fetch(`/api/feynman/${docId}?sessionId=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
      setPendingBySession((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (activeId === id) {
        setActiveId(null);
        setPendingChildPrompt(null);
      }
    },
    [activeId, docId],
  );

  if (sessions === null) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-[var(--ink-500)]">
        <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" /> loading...
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-canvas)]">
        <div className="m-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2">
          <div className="mb-2 flex items-center gap-1.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--accent-100)] bg-[var(--accent-50)] text-[var(--accent-700)]">
              <Lightbulb className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
                New session
              </label>
              <p className="truncate text-[10.5px] text-[var(--ink-400)]">Voice Feynman</p>
            </div>
          </div>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic, or whole doc"
            className="mb-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px] text-[var(--ink-900)] placeholder:text-[var(--ink-400)] focus:border-[var(--accent-500)] focus:outline-none"
            disabled={busy}
          />
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] py-1.5 text-[12px] font-medium text-white hover:bg-[var(--button-primary-hover)] disabled:opacity-50"
          >
            {busy ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> starting...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" /> Start session
              </>
            )}
          </button>
          {!active && error && (
            <div className="mt-2">
              <p className="text-[11px] leading-relaxed text-[var(--feedback-wrong-text)]">{error}</p>
              <button
                type="button"
                onClick={start}
                disabled={busy}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-[var(--feedback-wrong-border)] bg-[var(--feedback-wrong-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--feedback-wrong-text)] transition hover:opacity-80 disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" /> Retry
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
          <span>Past sessions</span>
          <span className="tabular-nums text-[var(--ink-400)]">{sessions.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-[11.5px] leading-relaxed text-[var(--ink-400)]">
              No sessions yet. Pick a topic above and explain it out loud.
            </p>
          ) : (
            sessions.map((s) => (
              <SessionListItem
                key={s.id}
                session={s}
                active={activeId === s.id}
                maxTurns={maxTurns}
                onSelect={() => {
                  setActiveId(s.id);
                  setError(null);
                  setPendingChildPrompt(s.endedAt ? null : pendingBySession[s.id] ?? null);
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
            icon={<Lightbulb className="h-7 w-7 text-[var(--ink-400)]" />}
            text="Pick a topic, then teach it back out loud. The orb listens; the agent asks short questions."
          />
        ) : (
          <ActiveSession
            session={active}
            pendingChildPrompt={pendingChildPrompt}
            busy={busy}
            onSubmit={submitExplanation}
            maxTurns={maxTurns}
            error={error}
          />
        )}
      </section>
    </div>
  );
}

function SessionListItem({
  session,
  active,
  maxTurns,
  onSelect,
  onDelete,
}: {
  session: FeynmanSession;
  active: boolean;
  maxTurns: number;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const progress = Math.min(100, (session.turns.length / Math.max(1, maxTurns)) * 100);
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
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            session.endedAt
              ? "bg-emerald-500"
              : session.turns.length > 0
                ? "bg-[var(--accent-500)]"
                : "bg-[var(--ink-300)]"
          }`}
        />
        <button
          type="button"
          onClick={onDelete}
          className="invisible flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--ink-400)] hover:bg-[var(--surface-sunken)] hover:text-[var(--feedback-wrong-icon)] group-hover:visible"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <button type="button" onClick={onSelect} className="mt-1 block w-full text-left">
        <div className="mb-1 flex items-center justify-between text-[10.5px] text-[var(--ink-400)]">
          <span>
            {session.turns.length}/{maxTurns} turns
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

function ActiveSession({
  session,
  pendingChildPrompt,
  busy,
  onSubmit,
  maxTurns,
  error,
}: {
  session: FeynmanSession;
  pendingChildPrompt: string | null;
  busy: boolean;
  onSubmit: (text: string) => void;
  maxTurns: number;
  error: string | null;
}) {
  const ended = session.endedAt != null;
  const progress = Math.min(100, (session.turns.length / Math.max(1, maxTurns)) * 100);
  const title = session.topic === "all" ? "Whole document" : session.topic;

  const feedbackParts = useMemo(() => splitFeedback(session.summary), [session.summary]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-5 py-2.5">
        <div className="mb-2 flex items-center justify-between gap-3 text-[11.5px] text-[var(--ink-500)]">
          <span className="flex min-w-0 items-center gap-2">
            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-[var(--accent-600)]" />
            <span className="truncate">
              Feynman / <strong className="font-medium text-[var(--ink-900)]">{title}</strong>
            </span>
          </span>
          <span className="shrink-0 tabular-nums">
            {session.turns.length}/{maxTurns}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
          <div
            className="h-full rounded-full bg-[var(--accent-500)] transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      {ended ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <FeedbackCard summary={session.summary} parts={feedbackParts} />
          </div>
        </div>
      ) : (
        <>
          {error && (
            <p className="shrink-0 border-b border-[var(--feedback-wrong-border)] bg-[var(--feedback-wrong-bg)] px-5 py-2 text-[11.5px] leading-relaxed text-[var(--feedback-wrong-text)]">
              {error} Your turn was kept — say or type it again to retry.
            </p>
          )}
          <VoiceConsole
            prompt={pendingChildPrompt}
            busy={busy}
            turnIndex={session.turns.length}
            onSubmit={onSubmit}
          />
        </>
      )}
    </div>
  );
}

type RecognitionLike = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onend: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
};
type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

function getSpeechRecognition(): (new () => RecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function VoiceConsole({
  prompt,
  busy,
  turnIndex,
  onSubmit,
}: {
  prompt: string | null;
  busy: boolean;
  turnIndex: number;
  onSubmit: (text: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [hasMicSupport] = useState(() => typeof navigator !== "undefined" && !!getSpeechRecognition());

  const recRef = useRef<RecognitionLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const finalRef = useRef<string>("");
  const spokenForPromptRef = useRef<string | null>(null);

  const stopMic = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      // already stopped
    }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    setLevel(0);
    setListening(false);
  }, []);

  const startMic = useCallback(async () => {
    setVoiceError(null);
    const SR = getSpeechRecognition();
    if (!SR) {
      setVoiceError("Voice input is not supported by this browser. Try Chrome, Edge or Safari.");
      return;
    }
    try {
      window.speechSynthesis?.cancel();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      analyserRef.current = an;

      const data = new Uint8Array(an.fftSize);
      const tick = () => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setLevel(Math.min(1, rms * 3.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language || "en-US";
      finalRef.current = "";
      setFinalText("");
      setInterimText("");
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const txt = res[0].transcript;
          if (res.isFinal) finalRef.current += txt + " ";
          else interim += txt;
        }
        setFinalText(finalRef.current);
        setInterimText(interim);
      };
      rec.onerror = () => {
        stopMic();
      };
      rec.onend = () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        setListening(false);
      };
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch (e) {
      stopMic();
      setVoiceError(
        e instanceof Error
          ? e.message.includes("Permission")
            ? "Microphone access denied."
            : e.message
          : "Could not start microphone.",
      );
    }
  }, [stopMic]);

  const handleStopAndSend = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      // already stopped
    }
    setTimeout(() => {
      const merged = (finalRef.current + " " + interimText).trim();
      stopMic();
      if (merged) onSubmit(merged);
    }, 250);
  }, [interimText, onSubmit, stopMic]);

  const speakPrompt = useCallback(
    async (text: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      const synth = window.speechSynthesis;
      try {
        const ensureVoices = () =>
          new Promise<void>((resolve) => {
            if (synth.getVoices().length > 0) {
              resolve();
              return;
            }
            const handler = () => {
              synth.removeEventListener("voiceschanged", handler);
              resolve();
            };
            synth.addEventListener("voiceschanged", handler);
            setTimeout(resolve, 1200);
          });
        await ensureVoices();
        synth.cancel();
        const lang = navigator.language || "en-US";
        const voices = synth.getVoices();
        const voice =
          voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
          voices.find((v) => v.lang.toLowerCase().startsWith(lang.split("-")[0].toLowerCase())) ??
          null;
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        if (voice) u.voice = voice;
        u.rate = 1;
        u.pitch = 1.05;
        u.onstart = () => setSpeaking(true);
        u.onend = () => setSpeaking(false);
        u.onerror = () => setSpeaking(false);
        synth.speak(u);
      } catch {
        setSpeaking(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!prompt) return;
    if (spokenForPromptRef.current === prompt) return;
    spokenForPromptRef.current = prompt;
    finalRef.current = "";
    setFinalText("");
    setInterimText("");
    speakPrompt(prompt);
  }, [prompt, speakPrompt]);

  useEffect(() => {
    return () => {
      stopMic();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, [stopMic]);

  const blobState: BlobState = busy
    ? "thinking"
    : listening
      ? "listening"
      : speaking
        ? "speaking"
        : "idle";

  const stateLabel = busy
    ? "Thinking..."
    : speaking
      ? "Reading the question..."
      : listening
        ? "Listening — speak naturally"
        : prompt
          ? `Tap the sphere to answer question ${turnIndex + 1}`
          : "Preparing the next question...";

  const hasTranscript = finalText.trim().length > 0 || interimText.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--surface-raised)] px-5 pt-4 pb-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center">
        {prompt && (
          <div className="flex w-full items-start gap-2 rounded-lg border border-[var(--accent-100)] bg-[var(--accent-50)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--ink-900)]">
            <button
              type="button"
              onClick={() => speakPrompt(prompt)}
              disabled={speaking}
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--accent-700)] transition-colors hover:bg-[var(--surface-sunken)] disabled:opacity-60"
              title={speaking ? "Reading..." : "Play question"}
              aria-label="Play question"
            >
              <Volume2 className="h-3.5 w-3.5" />
            </button>
            <p className="whitespace-pre-wrap pt-0.5">{prompt}</p>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 py-2">
        <button
          type="button"
          onClick={() => {
            if (busy || !prompt || !hasMicSupport) return;
            if (listening) handleStopAndSend();
            else startMic();
          }}
          disabled={busy || !prompt || !hasMicSupport}
          className="max-w-full rounded-full transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          title={listening ? "Tap to stop and send" : "Tap to speak"}
        >
          <VoiceBlob state={blobState} level={level} size={260} />
        </button>

        <p className="text-center text-[12.5px] font-medium tracking-tight text-[var(--ink-700)]">
          {stateLabel}
        </p>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-2">
        {hasTranscript && (
          <div className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ink-900)]">
            <span>{finalText}</span>
            <span className="text-[var(--ink-400)]">{interimText}</span>
          </div>
        )}
        {voiceError && (
          <p className="text-[11.5px] leading-relaxed text-[var(--feedback-wrong-text)]">{voiceError}</p>
        )}
        {!hasMicSupport && (
          <p className="text-[11.5px] leading-relaxed text-[var(--feedback-wrong-text)]">
            Voice input is not supported by this browser. Try Chrome, Edge or Safari.
          </p>
        )}
      </div>
    </div>
  );
}

function FeedbackCard({
  summary,
  parts,
}: {
  summary?: string;
  parts: string[];
}) {
  return (
    <div className="rounded-lg border border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[var(--feedback-correct-icon)]">
          <BookOpenCheck className="h-3.5 w-3.5" />
          <p className="text-[11px] font-semibold uppercase tracking-wider">Session feedback</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--feedback-correct-border)] bg-[var(--feedback-correct-bg)] px-2 py-1 text-[11px] font-medium text-[var(--feedback-correct-text)]">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Complete
        </span>
      </div>
      {parts.length > 1 ? (
        <div className="space-y-2">
          {parts.map((part, i) => (
            <p key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-900)]">
              {part}
            </p>
          ))}
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-900)]">
          {summary || "No written feedback was returned for this session."}
        </p>
      )}
    </div>
  );
}

function splitFeedback(summary?: string): string[] {
  if (!summary) return [];
  return summary
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
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
