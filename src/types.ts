export const MESSAGE_ROLES = ["user", "assistant", "tool"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const CONSULT_KINDS = [
  "plan",
  "stuck",
  "review",
  "risk",
  "decision",
  "handoff",
] as const;
export type ConsultKind = (typeof CONSULT_KINDS)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
export type AdviceStyle = "brief" | "detailed";

export interface ContextMessage {
  role: MessageRole;
  content: string;
  name?: string;
}

export interface ConsultRequest {
  sessionId: string;
  kind: ConsultKind;
  question: string;
  goal?: string;
  constraints?: string[];
  state?: string;
  transcriptPath?: string;
  context?: ContextMessage[];
  evidence?: string[];
  options?: string[];
  attempt?: string;
  expectedOutcome?: string;
  filesTouched?: string[];
  style?: "brief" | "detailed";
  includeHistory?: boolean;
  maxHistoryMessages?: number;
}

export interface Advice {
  verdict: "proceed" | "adjust" | "stop" | "need_more_context";
  summary: string;
  guidance: string[];
  risks: string[];
  nextActions: string[];
  evidenceGaps: string[];
  confidence: Confidence;
  consultId: string;
  sessionId: string;
  advisorModel: string;
  failures?: ModelFailure[];
  usage?: Usage;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface StoredTurn {
  timestamp: string;
  kind: ConsultKind;
  question: string;
  advice: Advice;
}

export interface SessionState {
  id: string;
  /** Folder the server was launched from (the host's project folder); lets a file store show which repo consulted. */
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  calls: number;
  callTimestamps?: number[];
  turns: StoredTurn[];
  summary?: string;
  goal?: string;
  constraints: string[];
  filesTouched: string[];
  openQuestions: string[];
  decisions: string[];
}

export interface SessionSnapshot {
  id: string;
  createdAt: string;
  updatedAt: string;
  calls: number;
  callsLastMinute: number;
  remainingCalls: number;
  goal?: string;
  constraints: string[];
  filesTouched: string[];
  openQuestions: string[];
  decisions: string[];
  recentTurns: Array<{
    timestamp: string;
    kind: ConsultKind;
    question: string;
    verdict: Advice["verdict"];
    summary: string;
  }>;
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionState | undefined>;
  save(session: SessionState): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
  prune?(olderThanMs: number): Promise<number>;
}

export interface ProviderRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  model: string;
  usage?: Usage;
  failures?: ModelFailure[];
}

export interface ModelFailure {
  model: string;
  reason: string;
}

export interface AdvisorProvider {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
