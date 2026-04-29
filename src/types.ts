export type Phase = 'explore' | 'converge' | 'finalized';

export type Rating = 0 | 1 | 2 | 3 | 4 | 5;

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
