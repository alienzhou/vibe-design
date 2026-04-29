import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildGenerationPrompt,
  listVariants,
  resolveNextPhase,
  shouldEnterConverge,
  upsertScore,
} from './explorer.js';
import { FallbackVariantGenerator, MockVariantGenerator, type VariantGenerator } from './generator.js';
import type { GenerationRequest, GenerationResult, Score } from './types.js';

describe('explorer workflow', () => {
  it('keeps scores unique per variant', () => {
    const scores = upsertScore([], 'variant-1', 2, 100);
    const updated = upsertScore(scores, 'variant-1', 5, 200);

    expect(updated).toEqual([{ variantId: 'variant-1', rating: 5, timestamp: 200 }]);
  });

  it('switches to converge when exploration has enough signal', () => {
    const scores: Score[] = [
      { variantId: 'variant-1', rating: 5, timestamp: 1 },
      { variantId: 'variant-2', rating: 5, timestamp: 2 },
      { variantId: 'variant-3', rating: 2, timestamp: 3 },
    ];

    expect(shouldEnterConverge(2, scores)).toBe(true);
    expect(resolveNextPhase('explore', 2, scores)).toBe('converge');
  });

  it('forces converge after four completed rounds', () => {
    expect(shouldEnterConverge(4, [{ variantId: 'variant-1', rating: 3, timestamp: 1 }])).toBe(true);
  });

  it('builds broad exploration and narrow convergence prompts', () => {
    const explorePrompt = buildGenerationPrompt('SaaS pricing page', 1, 'explore');
    const convergePrompt = buildGenerationPrompt('SaaS pricing page', 5, 'converge', [
      { variantId: 'variant-1', rating: 5, timestamp: 1 },
    ]);

    expect(explorePrompt).toContain('Generate 6 different UI design variations');
    expect(explorePrompt).toContain('deliberately contrasting option');
    expect(convergePrompt).toContain('Generate exactly 2 complete standalone HTML files');
    expect(convergePrompt).toContain('variant-1 (5)');
  });

  it('mock generator writes the expected variant count for each phase', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'design-explorer-'));
    const generator = new MockVariantGenerator();

    try {
      const exploreDir = join(workspace, 'round-1');
      await generator.generate({
        description: 'Dashboard',
        round: 1,
        phase: 'explore',
        outputDir: exploreDir,
        previousScores: [],
      });
      expect(listVariants(workspace, 1)).toHaveLength(6);

      const convergeDir = join(workspace, 'round-2');
      await generator.generate({
        description: 'Dashboard',
        round: 2,
        phase: 'converge',
        outputDir: convergeDir,
        previousScores: [{ variantId: 'variant-1', rating: 5, timestamp: 1 }],
      });
      expect(listVariants(workspace, 2)).toHaveLength(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('falls back to mock generation when the primary generator fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'design-explorer-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failingGenerator: VariantGenerator = {
      async generate(_request: GenerationRequest): Promise<GenerationResult> {
        throw new Error('spawn failed');
      },
    };
    const generator = new FallbackVariantGenerator(failingGenerator, new MockVariantGenerator());

    try {
      await generator.generate({
        description: 'Dashboard',
        round: 1,
        phase: 'explore',
        outputDir: join(workspace, 'round-1'),
        previousScores: [],
      });

      expect(listVariants(workspace, 1)).toHaveLength(6);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('using mock generator'));
      expect(readFileSync(join(workspace, 'round-1', 'generation.log'), 'utf-8')).toContain('Primary generation failed');
    } finally {
      warn.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
