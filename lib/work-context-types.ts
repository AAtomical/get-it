/**
 * Pure types for the work context.
 *
 * Imported by client components; the storage-side helpers live in
 * lib/work-context.ts and stay server-only because they use node:fs.
 */

import type { ProviderName } from "./provider-types";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

export type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Native conversation/thread id backing this chat. Set on the first
   *  assistant turn; later turns resume it and send only the new message
   *  (the document + prior turns stay in the engine's thread). Absent on
   *  pre-existing chats and after a session is lost — both fall back to a
   *  fresh full-context turn. */
  codexThreadId?: string;
  /** Which engine minted `codexThreadId`. A thread id is provider-specific,
   *  so we only resume it when the active provider matches; otherwise we
   *  transparently migrate by starting a fresh thread with the full history. */
  threadProvider?: ProviderName;
};

export type Flashcard = {
  q: string;
  a: string;
  userAnswer?: string;
  rating?: 1 | 2 | 3 | 4;
  answeredAt?: number;
};

export type FlashcardSession = {
  id: string;
  topic: string;
  createdAt: number;
  endedAt?: number;
  cards: Flashcard[];
};

export type FeynmanTurn = {
  childPrompt: string;
  userExplanation: string;
  ts: number;
};

export type FeynmanSession = {
  id: string;
  topic: string;
  createdAt: number;
  endedAt?: number;
  turns: FeynmanTurn[];
  summary?: string;
};

/** One multiple-choice quiz question. Options always have length 4, and
 *  `correctIndex` is in 0..3. After the student picks, `chosenIndex` and
 *  `answeredAt` are set; cards stay write-once (no editing past answers). */
export type QuizQuestion = {
  stem: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  chosenIndex?: number;
  answeredAt?: number;
};

export type QuizSession = {
  id: string;
  topic: string;
  createdAt: number;
  endedAt?: number;
  questions: QuizQuestion[];
};

export type WorkContext = {
  v: 1;
  docId: string;
  chats: ChatThread[];
  flashcards: FlashcardSession[];
  quizzes: QuizSession[];
  feynman: FeynmanSession[];
};
