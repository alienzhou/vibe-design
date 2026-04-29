import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { ensureDir, variantCountForPhase } from './explorer.js';
import { buildVariantPromptPlans } from './prompt-planner.js';
import type { GenerationProgressHandler, GenerationRequest, GenerationResult, VariantPromptPlan } from './types.js';

export interface VariantGenerator {
  generate(request: GenerationRequest, onProgress?: GenerationProgressHandler): Promise<GenerationResult>;
}

export const DEFAULT_CLAUDE_CODE_ALLOWED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'Read',
  'Bash(pwd)',
  'Bash(ls *)',
  'Bash(test *)',
  'Bash(mkdir *)',
  'Bash(touch *)',
  'Bash(cat *)',
  'Bash(tee *)',
  'Bash(printf *)',
  'Bash(echo *)',
];

export class ClaudeCliGenerator implements VariantGenerator {
  constructor(
    private readonly command: string = process.env.CLAUDE_CODE_COMMAND ?? 'claude',
    private readonly timeoutMs: number = readPositiveInteger(process.env.CLAUDE_CODE_TIMEOUT_MS, 1_800_000),
    private readonly parallelism: number = readPositiveInteger(process.env.CLAUDE_CODE_PARALLELISM, 3),
    private readonly permissionMode: string = process.env.CLAUDE_CODE_PERMISSION_MODE ?? 'acceptEdits',
    private readonly fallbackFailedVariants: boolean = false,
    private readonly allowedTools: string[] = readAllowedTools(process.env.CLAUDE_CODE_ALLOWED_TOOLS),
  ) {}

  async generate(request: GenerationRequest, onProgress?: GenerationProgressHandler): Promise<GenerationResult> {
    ensureDir(request.outputDir);
    const plans = buildVariantPromptPlans(request);
    writeGenerationLog(request.outputDir, [
      `Claude Code parallel generation started.`,
      `command=${this.command}`,
      `cwd=${request.outputDir}`,
      `outputDir=${request.outputDir}`,
      `round=${request.round}`,
      `phase=${request.phase}`,
      `variantCount=${plans.length}`,
      `parallelism=${this.parallelism}`,
      `permissionMode=${this.permissionMode}`,
      `allowedTools=${this.allowedTools.join(', ')}`,
      `timeoutMs=${this.timeoutMs}`,
    ].join('\n'));
    console.info(`[Design Explorer] Claude Code parallel generation started. outputDir=${request.outputDir} variants=${plans.length} parallelism=${this.parallelism} permissionMode=${this.permissionMode} allowedTools=${this.allowedTools.join(',')}`);

    const results = await runWithConcurrency(plans, this.parallelism, (plan) => this.generateSingleVariantOrFallback(request, plan, onProgress));
    return { output: results.join('\n') };
  }

  private async generateSingleVariantOrFallback(
    request: GenerationRequest,
    plan: VariantPromptPlan,
    onProgress?: GenerationProgressHandler,
  ): Promise<string> {
    try {
      return await this.generateSingleVariant(request, plan, onProgress);
    } catch (error) {
      if (!this.fallbackFailedVariants) {
        emitProgress(onProgress, {
          type: 'variant-failed',
          level: 'error',
          message: `Generation failed for ${plan.variantId}: ${formatError(error)}`,
          round: request.round,
          phase: request.phase,
          variantId: plan.variantId,
        });
        throw error;
      }

      return this.writeFallbackVariant(request, plan, error, onProgress);
    }
  }

  private async generateSingleVariant(
    request: GenerationRequest,
    plan: VariantPromptPlan,
    onProgress?: GenerationProgressHandler,
  ): Promise<string> {
    const promptPath = join(request.outputDir, `${plan.variantId}.prompt.md`);
    writeFileSync(promptPath, plan.prompt);
    writeGenerationLog(request.outputDir, [
      `Claude Code variant generation started.`,
      `variantId=${plan.variantId}`,
      `title=${plan.title}`,
      `outputFile=${plan.outputFile}`,
      `prompt=${promptPath}`,
    ].join('\n'));
    console.info(`[Design Explorer] Starting ${plan.variantId}. outputFile=${plan.outputFile} prompt=${promptPath}`);
    emitProgress(onProgress, {
      type: 'variant-started',
      level: 'info',
      message: `${plan.title} started.`,
      round: request.round,
      phase: request.phase,
      variantId: plan.variantId,
    });

    return new Promise((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        const args = buildClaudeCliArgs(plan.prompt, this.permissionMode, this.allowedTools);
        writeGenerationLog(request.outputDir, `Claude Code spawn args. variantId=${plan.variantId} args=${formatClaudeArgsForLog(args)}`);
        child = spawn(this.command, args, {
          cwd: request.outputDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new Error(`Failed to start Claude Code for ${plan.variantId}: ${formatError(error)}`));
        return;
      }

      writeGenerationLog(request.outputDir, `Claude Code process spawned. variantId=${plan.variantId} pid=${child.pid ?? 'unknown'}`);
      console.info(`[Design Explorer] Claude Code process spawned. variantId=${plan.variantId} pid=${child.pid ?? 'unknown'}`);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        child.kill('SIGTERM');
        writeGenerationLog(request.outputDir, `Claude Code timed out after ${this.timeoutMs}ms. variantId=${plan.variantId}. Sent SIGTERM.`, 'error');
        console.error(`[Design Explorer] Claude Code timed out after ${this.timeoutMs}ms. variantId=${plan.variantId} outputDir=${request.outputDir}`);
        emitProgress(onProgress, {
          type: 'variant-failed',
          level: 'error',
          message: `${plan.variantId} timed out after ${this.timeoutMs}ms.`,
          round: request.round,
          phase: request.phase,
          variantId: plan.variantId,
        });
        reject(new Error(`Claude Code timed out for ${plan.variantId}.`));
      }, this.timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        writeStreamChunk(request.outputDir, plan.variantId, 'stdout', text);
        emitStreamProgress(onProgress, request, plan.variantId, 'stdout', text);
      });

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        writeStreamChunk(request.outputDir, plan.variantId, 'stderr', text);
        emitStreamProgress(onProgress, request, plan.variantId, 'stderr', text);
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        writeGenerationLog(request.outputDir, `Claude Code process error. variantId=${plan.variantId} error=${error.message}`, 'error');
        console.error(`[Design Explorer] Claude Code process error. variantId=${plan.variantId} error=${error.message}`);
        emitProgress(onProgress, {
          type: 'variant-failed',
          level: 'error',
          message: `Failed to start ${plan.variantId}: ${error.message}`,
          round: request.round,
          phase: request.phase,
          variantId: plan.variantId,
        });
        reject(new Error(`Failed to start Claude Code for ${plan.variantId}: ${error.message}`));
      });

      child.on('close', (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        writeGenerationLog(request.outputDir, [
          `Claude Code process closed.`,
          `variantId=${plan.variantId}`,
          `code=${code ?? 'null'}`,
          `signal=${signal ?? 'null'}`,
          `stdoutBytes=${Buffer.byteLength(stdout)}`,
          `stderrBytes=${Buffer.byteLength(stderr)}`,
        ].join('\n'), code === 0 ? 'info' : 'error');
        console.info(`[Design Explorer] Claude Code process closed. variantId=${plan.variantId} code=${code ?? 'null'} signal=${signal ?? 'null'} outputDir=${request.outputDir}`);

        if (code !== 0) {
          emitProgress(onProgress, {
            type: 'variant-failed',
            level: 'error',
            message: `${plan.variantId} exited with code ${code}.`,
            round: request.round,
            phase: request.phase,
            variantId: plan.variantId,
          });
          reject(new Error(`Claude Code exited with code ${code} for ${plan.variantId}: ${stderr}`));
          return;
        }

        if (!existsSync(join(request.outputDir, plan.outputFile))) {
          emitProgress(onProgress, {
            type: 'variant-failed',
            level: 'error',
            message: `${plan.variantId} finished without creating ${plan.outputFile}.`,
            round: request.round,
            phase: request.phase,
            variantId: plan.variantId,
          });
          reject(new Error(`Claude Code exited successfully but did not create ${plan.outputFile}.`));
          return;
        }

        emitProgress(onProgress, {
          type: 'variant-completed',
          level: 'info',
          message: `${plan.variantId} completed.`,
          round: request.round,
          phase: request.phase,
          variantId: plan.variantId,
        });
        resolve(stdout);
      });
    });
  }

  private writeFallbackVariant(
    request: GenerationRequest,
    plan: VariantPromptPlan,
    error: unknown,
    onProgress?: GenerationProgressHandler,
  ): string {
    const message = `Variant generation failed, writing fallback file. variantId=${plan.variantId} reason=${formatError(error)}`;
    writeGenerationLog(request.outputDir, message, 'warn');
    console.warn(`[Design Explorer] ${message}`);
    emitProgress(onProgress, {
      type: 'variant-fallback',
      level: 'warn',
      message: `${plan.variantId} failed, using fallback variant.`,
      round: request.round,
      phase: request.phase,
      variantId: plan.variantId,
    });

    const html = renderMockHtml(
      `${request.description}\n\nFallback for ${plan.title}: ${plan.hypothesis}`,
      plan.title,
      '#111827',
      '#f8fafc',
      '#8b5cf6',
    );
    writeFileSync(join(request.outputDir, plan.outputFile), html);
    return message;
  }
}

export class MockVariantGenerator implements VariantGenerator {
  async generate(request: GenerationRequest, onProgress?: GenerationProgressHandler): Promise<GenerationResult> {
    ensureDir(request.outputDir);

    const styles = [
      ['Minimal White', '#ffffff', '#111827', '#2563eb'],
      ['Dark Tech', '#0f172a', '#e5e7eb', '#22c55e'],
      ['Gradient Energy', 'linear-gradient(135deg, #667eea, #764ba2)', '#ffffff', '#ffffff'],
      ['Soft Nature', '#f4f1ea', '#243026', '#2f855a'],
      ['Business Pro', '#f8fafc', '#0f172a', '#0f62fe'],
      ['Creative Bold', '#1a102f', '#f8fafc', '#f43f5e'],
    ] as const;

    const count = variantCountForPhase(request.phase);

    for (let index = 0; index < count; index += 1) {
      const variantId = `variant-${index + 1}`;
      emitProgress(onProgress, {
        type: 'variant-started',
        level: 'info',
        message: `${variantId} mock generation started.`,
        round: request.round,
        phase: request.phase,
        variantId,
      });
      const [name, background, text, accent] = styles[index % styles.length];
      const html = renderMockHtml(request.description, name, background, text, accent);
      writeFileSync(join(request.outputDir, `${variantId}.html`), html);
      emitProgress(onProgress, {
        type: 'variant-completed',
        level: 'info',
        message: `${variantId} mock generation completed.`,
        round: request.round,
        phase: request.phase,
        variantId,
      });
    }

    return { output: `Generated ${count} mock variants.` };
  }
}

export class FallbackVariantGenerator implements VariantGenerator {
  constructor(
    private readonly primary: VariantGenerator,
    private readonly fallback: VariantGenerator,
  ) {}

  async generate(request: GenerationRequest, onProgress?: GenerationProgressHandler): Promise<GenerationResult> {
    try {
      return await this.primary.generate(request, onProgress);
    } catch (error) {
      const message = `Primary generation failed, using mock generator: ${formatError(error)}`;
      writeGenerationLog(request.outputDir, message, 'warn');
      console.warn(`[Design Explorer] ${message}`);
      return this.fallback.generate(request, onProgress);
    }
  }
}

export function createGenerator(): VariantGenerator {
  const mode = process.env.DESIGN_EXPLORER_GENERATOR;

  if (mode === 'mock') {
    return new MockVariantGenerator();
  }

  if (mode === 'claude') {
    return new ClaudeCliGenerator();
  }

  return new FallbackVariantGenerator(
    new ClaudeCliGenerator(undefined, undefined, undefined, undefined, true),
    new MockVariantGenerator(),
  );
}

export function buildClaudeCliArgs(prompt: string, permissionMode: string, allowedTools: string[]): string[] {
  const args = ['--permission-mode', permissionMode];
  if (allowedTools.length > 0) {
    args.push('--allowedTools', ...allowedTools);
  }

  args.push('-p', prompt);
  return args;
}

function renderMockHtml(description: string, name: string, background: string, text: string, accent: string): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: ${background};
      color: ${text};
      display: grid;
      place-items: center;
      padding: 48px;
    }
    main {
      width: min(960px, 100%);
      display: grid;
      gap: 32px;
    }
    .hero {
      padding: 56px;
      border-radius: 28px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.18);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.16);
      backdrop-filter: blur(16px);
    }
    h1 {
      margin: 0 0 18px;
      font-size: clamp(40px, 7vw, 76px);
      line-height: 0.95;
      letter-spacing: -0.06em;
    }
    p {
      max-width: 640px;
      margin: 0;
      font-size: 18px;
      line-height: 1.7;
      opacity: 0.78;
    }
    button {
      margin-top: 32px;
      border: 0;
      border-radius: 999px;
      padding: 15px 24px;
      color: ${background === '#ffffff' || background === '#f8fafc' || background === '#f4f1ea' ? '#fff' : '#111827'};
      background: ${accent};
      font-weight: 700;
      cursor: pointer;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
    }
    .card {
      padding: 22px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.14);
      border: 1px solid rgba(255, 255, 255, 0.16);
    }
    .card strong {
      display: block;
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>${escapeHtml(description)}</h1>
      <p>${escapeHtml(name)} direction with clear hierarchy, deliberate spacing, and reusable component signals.</p>
      <button>Start exploring</button>
    </section>
    <section class="cards">
      <div class="card"><strong>Visual layer</strong><span>Readable code as design reference.</span></div>
      <div class="card"><strong>Tokens</strong><span>Stable values for colors and spacing.</span></div>
      <div class="card"><strong>Intent</strong><span>Rules that preserve product consistency.</span></div>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[char];
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readAllowedTools(value: string | undefined): string[] {
  if (!value) {
    return DEFAULT_CLAUDE_CODE_ALLOWED_TOOLS;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatClaudeArgsForLog(args: string[]): string {
  return args.map((arg) => (arg === args.at(-1) ? '<prompt>' : arg)).join(' ');
}

function emitProgress(
  onProgress: GenerationProgressHandler | undefined,
  event: Omit<Parameters<GenerationProgressHandler>[0], 'timestamp'>,
): void {
  onProgress?.({ ...event, timestamp: Date.now() });
}

function emitStreamProgress(
  onProgress: GenerationProgressHandler | undefined,
  request: GenerationRequest,
  variantId: string,
  stream: 'stdout' | 'stderr',
  text: string,
): void {
  const message = summarizeStreamChunk(text);
  if (!message) {
    return;
  }

  emitProgress(onProgress, {
    type: 'variant-output',
    level: stream === 'stderr' ? 'warn' : 'info',
    message,
    round: request.round,
    phase: request.phase,
    variantId,
    stream,
  });
}

function summarizeStreamChunk(text: string): string {
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (!line) {
    return '';
  }

  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

export function writeGenerationLog(outputDir: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  ensureDir(outputDir);
  const timestamp = new Date().toISOString();
  appendFileSync(join(outputDir, 'generation.log'), `[${timestamp}] [${level}] ${message}\n`);
}

function writeStreamChunk(outputDir: string, variantId: string, stream: 'stdout' | 'stderr', text: string): void {
  writeGenerationLog(outputDir, `${stream} (${variantId}):\n${text.trimEnd()}`);
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) {
      console.info(`[Claude Code ${variantId} ${stream}] ${line}`);
    }
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
