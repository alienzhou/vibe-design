import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLARIFICATION_TAG, parseClarificationPayload } from './clarification.js';
import {
  buildGenerationPrompt,
  createInitialState,
  explorationDir,
  listVariants,
  listExplorations,
  resolveNextPhase,
  shouldEnterConverge,
  upsertScore,
  writeState,
} from './explorer.js';
import { ClaudeCliGenerator, FallbackVariantGenerator, MockVariantGenerator, type VariantGenerator } from './generator.js';
import { buildVariantPromptPlans } from './prompt-planner.js';
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

  it('builds isolated prompt plans for parallel variant generation', () => {
    const plans = buildVariantPromptPlans({
      description: '横调结果报告页面',
      round: 1,
      phase: 'explore',
      outputDir: '/tmp/round-1',
      previousScores: [],
    });

    expect(plans).toHaveLength(6);
    expect(plans[0].outputFile).toBe('variant-1.html');
    expect(new Set(plans.map((plan) => plan.axes.architecture)).size).toBeGreaterThan(1);
    expect(plans[0].prompt).toContain('exactly one variant');
    expect(plans[0].prompt).toContain('ASCII/page-map sections');
  });

  it('parses tagged clarification questions into frontend-safe JSON', () => {
    const payload = parseClarificationPayload(`
      <${CLARIFICATION_TAG}>
      {
        "version": 1,
        "summary": "生成报告页面",
        "questions": [
          {
            "id": "target_reader",
            "label": "Who reads it?",
            "why": "Reader changes hierarchy.",
            "type": "single_select",
            "required": true,
            "options": ["manager", "engineer"]
          }
        ],
        "assumptions": ["Use sketch-first candidates."]
      }
      </${CLARIFICATION_TAG}>
    `);

    expect(payload.questions[0]).toMatchObject({
      id: 'target_reader',
      type: 'single_select',
      options: ['manager', 'engineer'],
    });
  });

  it('lists multiple exploration batches by update time', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'design-explorer-'));

    try {
      const first = createInitialState('First exploration', 'exploration-first', 100);
      const second = createInitialState('Second exploration', 'exploration-second', 200);
      const firstDir = explorationDir(workspace, first.id);
      const secondDir = explorationDir(workspace, second.id);
      writeState(firstDir, first);
      writeState(secondDir, second);
      writeFileSync(join(firstDir, 'state.json'), JSON.stringify({ ...first, updatedAt: 100 }, null, 2));
      writeFileSync(join(secondDir, 'state.json'), JSON.stringify({ ...second, updatedAt: 200 }, null, 2));

      const explorations = listExplorations(workspace);
      expect(explorations).toHaveLength(2);
      expect(explorations[0].description).toBe('Second exploration');
      expect(explorations[1].description).toBe('First exploration');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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

  it('falls back per variant when Claude exits without writing the expected file', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'design-explorer-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const command = join(workspace, 'noop-claude.sh');
      writeFileSync(command, '#!/bin/sh\necho "no file written"\nexit 0\n');
      chmodSync(command, 0o755);

      const outputDir = join(workspace, 'round-1');
      const generator = new ClaudeCliGenerator(command, 1_000, 2, 'acceptEdits', true);
      await generator.generate({
        description: 'Dashboard',
        round: 1,
        phase: 'explore',
        outputDir,
        previousScores: [],
      });

      expect(listVariants(workspace, 1)).toHaveLength(6);
      expect(readFileSync(join(outputDir, 'generation.log'), 'utf-8')).toContain('did not create variant-1.html');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('writing fallback file'));
    } finally {
      warn.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
