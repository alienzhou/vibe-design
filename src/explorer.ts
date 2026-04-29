import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExplorerState, Phase, Rating, Score, Variant } from './types.js';

export const VARIANT_ID_PATTERN = /^variant-\d+$/;

export function createInitialState(description: string): ExplorerState {
  return {
    round: 1,
    phase: 'explore',
    variants: [],
    scores: [],
    userDescription: description,
    history: [],
  };
}

export function assertRating(value: unknown): asserts value is Rating {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 5) {
    throw new Error('Rating must be an integer between 0 and 5.');
  }
}

export function assertVariantId(value: string): void {
  if (!VARIANT_ID_PATTERN.test(value)) {
    throw new Error('Invalid variant id.');
  }
}

export function upsertScore(scores: Score[], variantId: string, rating: Rating, timestamp = Date.now()): Score[] {
  assertVariantId(variantId);
  const nextScore: Score = { variantId, rating, timestamp };
  const existingIndex = scores.findIndex((score) => score.variantId === variantId);

  if (existingIndex === -1) {
    return [...scores, nextScore];
  }

  return scores.map((score, index) => (index === existingIndex ? nextScore : score));
}

export function scoreVariance(scores: Score[]): number {
  if (scores.length === 0) {
    return 0;
  }

  const mean = scores.reduce((sum, score) => sum + score.rating, 0) / scores.length;
  return scores.reduce((sum, score) => sum + (score.rating - mean) ** 2, 0) / scores.length;
}

export function shouldEnterConverge(completedRound: number, scores: Score[]): boolean {
  const lovedCount = scores.filter((score) => score.rating === 5).length;
  const highRatedCount = scores.filter((score) => score.rating >= 4).length;

  return completedRound >= 4 || lovedCount >= 2 || (highRatedCount >= 2 && scoreVariance(scores) <= 1);
}

export function resolveNextPhase(currentPhase: Phase, completedRound: number, scores: Score[]): Phase {
  if (currentPhase === 'finalized') {
    return 'finalized';
  }

  if (currentPhase === 'converge') {
    return 'converge';
  }

  return shouldEnterConverge(completedRound, scores) ? 'converge' : 'explore';
}

export function variantCountForPhase(phase: Phase): number {
  return phase === 'converge' ? 2 : 6;
}

export function buildGenerationPrompt(description: string, round: number, phase: Phase, previousScores: Score[] = []): string {
  const variantCount = variantCountForPhase(phase);
  const highRated = previousScores.filter((score) => score.rating >= 4);
  const lowRated = previousScores.filter((score) => score.rating <= 2);
  const neutral = previousScores.filter((score) => score.rating === 3);

  const feedback = [
    highRated.length > 0 ? `High-rated variants: ${highRated.map((score) => `${score.variantId} (${score.rating})`).join(', ')}` : '',
    neutral.length > 0 ? `Neutral variants: ${neutral.map((score) => score.variantId).join(', ')}` : '',
    lowRated.length > 0 ? `Low-rated variants: ${lowRated.map((score) => `${score.variantId} (${score.rating})`).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  if (phase === 'converge') {
    return `You are helping converge a UI design direction for: "${description}".

Current round: ${round}
Phase: converge

User feedback:
${feedback || 'No previous feedback.'}

Generate exactly ${variantCount} complete standalone HTML files with inline CSS:
- variant-1.html: refine the strongest high-rated direction.
- variant-2.html: make a subtle opposing alternative on one meaningful axis, such as spacing, density, color temperature, or typography.

Keep the global product intent stable. Only optimize visual details, layout rhythm, hierarchy, accessibility, and interaction states.`;
  }

  return `Generate ${variantCount} different UI design variations for: "${description}".

Current round: ${round}
Phase: explore

User feedback:
${feedback || 'This is the first round. Explore broadly.'}

Requirements:
- Output exactly ${variantCount} separate complete standalone HTML files with inline CSS.
- File names must be variant-1.html through variant-${variantCount}.html.
- Each variation should explore a distinct aesthetic direction across color, layout, typography, density, and visual hierarchy.
- Keep and refine high-rated directions, avoid low-rated traits, and include at least one deliberately contrasting option to expose blind spots.
- Include key component states where useful, such as buttons, cards, forms, hover states, and empty states.`;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function roundDir(workspaceDir: string, round: number): string {
  return join(workspaceDir, `round-${round}`);
}

export function listVariants(workspaceDir: string, round: number): Variant[] {
  const dir = roundDir(workspaceDir, round);

  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((filename) => /^variant-\d+\.html$/.test(filename))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
    .map((filename) => {
      const id = filename.replace(/\.html$/, '');
      return {
        id,
        round,
        filename,
        path: `/workspace/round-${round}/${filename}`,
      };
    });
}

export function stateFile(workspaceDir: string): string {
  return join(workspaceDir, 'state.json');
}

export function readState(workspaceDir: string): ExplorerState | null {
  const file = stateFile(workspaceDir);

  if (!existsSync(file)) {
    return null;
  }

  return JSON.parse(readFileSync(file, 'utf-8')) as ExplorerState;
}

export function writeState(workspaceDir: string, state: ExplorerState): void {
  ensureDir(workspaceDir);
  writeFileSync(stateFile(workspaceDir), JSON.stringify(state, null, 2));
}
