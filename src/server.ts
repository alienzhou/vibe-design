import express, { type Request, type Response } from 'express';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildClarificationPrompt, generateClarificationPayload } from './clarification.js';
import {
  assertRating,
  assertVariantId,
  createInitialState,
  ensureDir,
  explorationDir,
  listVariants,
  listExplorations,
  readState,
  readCurrentExplorationId,
  resolveNextPhase,
  roundDir,
  upsertScore,
  writeCurrentExplorationId,
  writeState,
} from './explorer.js';
import { createGenerator, DEFAULT_CLAUDE_CODE_ALLOWED_TOOLS, type VariantGenerator } from './generator.js';
import type { ExplorerState, GenerationProgressEvent, Score } from './types.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, '..');
const defaultWorkspaceDir = process.env.DESIGN_EXPLORER_WORKSPACE
  ? resolve(process.env.DESIGN_EXPLORER_WORKSPACE)
  : join(projectRoot, 'workspace');
const publicDir = join(projectRoot, 'public');

interface CreateAppOptions {
  workspaceDir?: string;
  generator?: VariantGenerator;
}

export function createApp(options: CreateAppOptions = {}) {
  const workspaceDir = options.workspaceDir ?? defaultWorkspaceDir;
  const generator = options.generator ?? createGenerator();
  let currentExplorationId = readCurrentExplorationId(workspaceDir);
  let currentState = currentExplorationId ? readState(explorationDir(workspaceDir, currentExplorationId)) : null;
  const progressClients = new Set<Response>();
  if (!currentState) {
    currentExplorationId = null;
  }

  ensureDir(workspaceDir);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(publicDir));
  app.use('/workspace', express.static(workspaceDir));

  app.get('/api/state', (_req, res) => {
    res.json(currentState ?? emptyState());
  });

  app.get('/api/explorations', (_req, res) => {
    res.json({ explorations: listExplorations(workspaceDir), currentExplorationId });
  });

  app.get('/api/progress', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sendProgressEvent(res, {
      type: 'round-started',
      level: 'info',
      message: 'Waiting for generation to start.',
      timestamp: Date.now(),
    });
    progressClients.add(res);

    req.on('close', () => {
      progressClients.delete(res);
    });
  });

  app.post('/api/explorations/:id/select', (req, res) => {
    try {
      currentState = readState(explorationDir(workspaceDir, req.params.id));
      if (!currentState) {
        throw new Error('Exploration not found.');
      }

      currentExplorationId = currentState.id;
      currentState.variants = listVariants(activeDir(), currentState.round, activePublicBasePath());
      writeCurrentExplorationId(workspaceDir, currentState.id);
      res.json(currentState);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/start', async (req, res) => {
    try {
      const description = readDescription(req);
      currentState = createInitialState(description);
      currentExplorationId = currentState.id;
      ensureDir(activeDir());
      writeCurrentExplorationId(workspaceDir, currentState.id);
      currentState = await generateRound(currentState, []);
      writeState(activeDir(), currentState);
      res.json(currentState);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/clarify', async (req, res) => {
    try {
      const description = readDescription(req);
      const previousExplorations = listExplorations(workspaceDir).map((summary) => summary.description);
      const clarification = await generateClarificationPayload(description, previousExplorations);
      res.json({
        prompt: buildClarificationPrompt(description, previousExplorations),
        ...clarification,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/variants', (_req, res) => {
    if (!currentState) {
      res.json(emptyState());
      return;
    }

    currentState.variants = listVariants(activeDir(), currentState.round, activePublicBasePath());
    writeState(activeDir(), currentState);
    res.json(currentState);
  });

  app.post('/api/score', (req, res) => {
    try {
      if (!currentState) {
        throw new Error('Exploration has not started.');
      }

      const { variantId, rating } = req.body as { variantId?: string; rating?: unknown };
      if (!variantId) {
        throw new Error('Variant id is required.');
      }

      assertVariantId(variantId);
      assertRating(rating);

      if (!currentState.variants.some((variant) => variant.id === variantId)) {
        throw new Error('Variant not found.');
      }

      currentState.scores = upsertScore(currentState.scores, variantId, rating);
      writeState(activeDir(), currentState);
      res.json({ scores: currentState.scores });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/next-round', async (req, res) => {
    try {
      if (!currentState) {
        throw new Error('Exploration has not started.');
      }

      if (currentState.scores.length === 0) {
        throw new Error('At least one score is required before generating the next round.');
      }

      const userRequestedConverge = Boolean((req.body as { enterConverge?: unknown }).enterConverge);

      const previousScores = [...currentState.scores];
      currentState.history = [
        ...currentState.history,
        {
          round: currentState.round,
          phase: currentState.phase,
          variants: currentState.variants,
          scores: previousScores,
        },
      ];
      currentState.phase = resolveNextPhase(currentState.phase, currentState.round, { userRequestedConverge });
      currentState.round += 1;
      currentState.scores = [];
      currentState.variants = [];

      currentState = await generateRound(currentState, previousScores);
      writeState(activeDir(), currentState);
      res.json(currentState);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/variant/:id', (req, res) => {
    try {
      if (!currentState) {
        throw new Error('Exploration has not started.');
      }

      const id = req.params.id;
      assertVariantId(id);

      const filepath = join(roundDir(activeDir(), currentState.round), `${id}.html`);
      if (!existsSync(filepath)) {
        res.status(404).json({ error: 'Variant not found.' });
        return;
      }

      res.json({ id, content: readFileSync(filepath, 'utf-8') });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/finalize', (req, res) => {
    try {
      if (!currentState) {
        throw new Error('Exploration has not started.');
      }

      const requestedVariantId = (req.body as { variantId?: string }).variantId;
      const variantId = requestedVariantId ?? pickHighestRatedVariant(currentState.scores);
      assertVariantId(variantId);

      const variant = currentState.variants.find((item) => item.id === variantId);
      if (!variant) {
        throw new Error('Variant not found.');
      }

      const outputDir = join(activeDir(), 'output');
      ensureDir(outputDir);
      copyFileSync(join(roundDir(activeDir(), currentState.round), variant.filename), join(outputDir, 'final.html'));

      const profile = {
        description: currentState.userDescription,
        finalizedVariantId: variantId,
        round: currentState.round,
        scores: currentState.scores,
        history: currentState.history,
      };
      writeFileSync(join(outputDir, 'style-profile.json'), JSON.stringify(profile, null, 2));

      currentState.phase = 'finalized';
      currentState.finalizedVariantId = variantId;
      currentState.finalOutputPath = `${activePublicBasePath()}/output/final.html`;
      writeState(activeDir(), currentState);

      res.json(currentState);
    } catch (error) {
      sendError(res, error);
    }
  });

  async function generateRound(state: ExplorerState, previousScores: Score[]): Promise<ExplorerState> {
    const outputDir = roundDir(activeDir(), state.round);
    ensureDir(outputDir);
    console.info(`[Design Explorer] Generating round=${state.round} phase=${state.phase} outputDir=${outputDir}`);
    broadcastProgress({
      type: 'round-started',
      level: 'info',
      message: `Round ${state.round} generation started.`,
      timestamp: Date.now(),
      round: state.round,
      phase: state.phase,
    });

    await generator.generate({
      description: state.userDescription,
      round: state.round,
      phase: state.phase,
      outputDir,
      previousScores,
    }, broadcastProgress);

    const variants = listVariants(activeDir(), state.round, activePublicBasePath());
    if (variants.length === 0) {
      throw new Error('No variants were generated.');
    }

    console.info(`[Design Explorer] Generated ${variants.length} variant(s). round=${state.round} outputDir=${outputDir}`);
    broadcastProgress({
      type: 'round-completed',
      level: 'info',
      message: `Round ${state.round} generated ${variants.length} variant(s).`,
      timestamp: Date.now(),
      round: state.round,
      phase: state.phase,
    });
    return { ...state, variants };
  }

  function broadcastProgress(event: GenerationProgressEvent): void {
    for (const client of progressClients) {
      if (client.destroyed) {
        progressClients.delete(client);
        continue;
      }

      sendProgressEvent(client, event);
    }
  }

  function activeDir(): string {
    if (!currentExplorationId) {
      throw new Error('Exploration has not started.');
    }

    return explorationDir(workspaceDir, currentExplorationId);
  }

  function activePublicBasePath(): string {
    if (!currentExplorationId) {
      throw new Error('Exploration has not started.');
    }

    return currentExplorationId === 'legacy'
      ? '/workspace'
      : `/workspace/explorations/${currentExplorationId}`;
  }

  return app;
}

function readDescription(req: Request): string {
  const description = (req.body as { description?: unknown }).description;

  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('Description is required.');
  }

  return description.trim();
}

function pickHighestRatedVariant(scores: Score[]): string {
  if (scores.length === 0) {
    throw new Error('Variant id is required when no scores exist.');
  }

  return [...scores].sort((a, b) => b.rating - a.rating || a.timestamp - b.timestamp)[0].variantId;
}

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown error.';
  res.status(400).json({ error: message });
}

function sendProgressEvent(res: Response, event: GenerationProgressEvent): void {
  res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
}

function emptyState(): ExplorerState {
  return {
    round: 0,
    phase: 'explore',
    variants: [],
    scores: [],
    userDescription: '',
    history: [],
    id: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3456);
  createApp().listen(port, () => {
    console.log(`Design Explorer running at http://localhost:${port}`);
    console.log(`Workspace: ${defaultWorkspaceDir}`);
    console.log(`Generator mode: ${process.env.DESIGN_EXPLORER_GENERATOR ?? 'claude-with-mock-fallback'}`);
    console.log(`Claude command: ${process.env.CLAUDE_CODE_COMMAND ?? 'claude'}`);
    console.log(`Claude timeout: ${process.env.CLAUDE_CODE_TIMEOUT_MS ?? '1800000'}ms`);
    console.log(`Claude parallelism: ${process.env.CLAUDE_CODE_PARALLELISM ?? '3'}`);
    console.log(`Claude permission mode: ${process.env.CLAUDE_CODE_PERMISSION_MODE ?? 'acceptEdits'}`);
    console.log(`Claude allowed tools: ${process.env.CLAUDE_CODE_ALLOWED_TOOLS ?? DEFAULT_CLAUDE_CODE_ALLOWED_TOOLS.join(', ')}`);
  });
}
