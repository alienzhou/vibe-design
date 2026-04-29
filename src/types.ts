export type Phase = 'explore' | 'converge' | 'finalized';

export type Rating = 0 | 1 | 2 | 3 | 4 | 5;

export type ClarificationQuestionType = 'text' | 'single_select' | 'multi_select';

export interface ClarificationQuestion {
  id: string;
  label: string;
  why: string;
  type: ClarificationQuestionType;
  required: boolean;
  options?: string[];
  defaultValue?: string | string[];
}

export interface ClarificationPayload {
  version: 1;
  summary: string;
  questions: ClarificationQuestion[];
  assumptions: string[];
}

export interface Variant {
  id: string;
  round: number;
  filename: string;
  path: string;
}

export interface Score {
  variantId: string;
  rating: Rating;
  timestamp: number;
}

export interface RoundState {
  round: number;
  phase: Phase;
  variants: Variant[];
  scores: Score[];
}

export interface ExplorerState {
  round: number;
  phase: Phase;
  variants: Variant[];
  scores: Score[];
  userDescription: string;
  history: RoundState[];
  finalizedVariantId?: string;
  finalOutputPath?: string;
}

export interface GenerationRequest {
  description: string;
  round: number;
  phase: Phase;
  outputDir: string;
  previousScores: Score[];
}

export interface GenerationResult {
  output: string;
}

export interface CandidateAxes {
  architecture: string;
  logic: string;
  density: string;
  expression: string;
  interaction: string;
}

export interface VariantPromptPlan {
  variantId: string;
  title: string;
  hypothesis: string;
  axes: CandidateAxes;
  outputFile: string;
  prompt: string;
}
