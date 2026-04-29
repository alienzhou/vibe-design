import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { buildGenerationPrompt, ensureDir, variantCountForPhase } from './explorer.js';
import type { GenerationRequest, GenerationResult } from './types.js';

export interface VariantGenerator {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

export class ClaudeCliGenerator implements VariantGenerator {
  constructor(
    private readonly command = process.env.CLAUDE_CODE_COMMAND ?? 'claude',
    private readonly timeoutMs = Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 120_000),
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    ensureDir(request.outputDir);
    const prompt = `${buildGenerationPrompt(request.description, request.round, request.phase, request.previousScores)}

Save all generated files directly in this directory:
${request.outputDir}`;

    return new Promise((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(this.command, ['-p', prompt], {
          cwd: request.outputDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new Error(`Failed to start Claude Code: ${formatError(error)}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        child.kill('SIGTERM');
        reject(new Error('Claude Code timed out.'));
      }, this.timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to start Claude Code: ${error.message}`));
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        if (code !== 0) {
          reject(new Error(`Claude Code exited with code ${code}: ${stderr}`));
          return;
        }

        resolve({ output: stdout });
      });
    });
  }
}

export class MockVariantGenerator implements VariantGenerator {
  async generate(request: GenerationRequest): Promise<GenerationResult> {
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
      const [name, background, text, accent] = styles[index % styles.length];
      const html = renderMockHtml(request.description, name, background, text, accent);
      writeFileSync(join(request.outputDir, `variant-${index + 1}.html`), html);
    }

    return { output: `Generated ${count} mock variants.` };
  }
}

export class FallbackVariantGenerator implements VariantGenerator {
  constructor(
    private readonly primary: VariantGenerator,
    private readonly fallback: VariantGenerator,
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    try {
      return await this.primary.generate(request);
    } catch (error) {
      console.warn(`Claude Code generation failed, using mock generator: ${formatError(error)}`);
      return this.fallback.generate(request);
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

  return new FallbackVariantGenerator(new ClaudeCliGenerator(), new MockVariantGenerator());
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
