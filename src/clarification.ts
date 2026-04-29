import { spawn } from 'node:child_process';
import type { ClarificationPayload, ClarificationQuestion } from './types.js';

export const CLARIFICATION_TAG = 'design-explorer-clarification';

export function buildClarificationPrompt(description: string, previousExplorations: string[] = []): string {
  const previousContext = previousExplorations.length > 0
    ? `\nPrevious exploration signals:\n${previousExplorations.slice(0, 5).map((item) => `- ${item}`).join('\n')}\n\nUse these only as weak preference signals. Do not copy old questions.`
    : '';

  return `You are preparing a sketch-first design exploration.

User request:
${description}
${previousContext}

Generate 3-5 broad, high-signal clarification questions before variants are generated.

Question design rules:
- Questions must be tailored to the user's request, not a fixed checklist.
- Prefer broad role perspectives such as interaction designer, AI engineer, product strategist, information architect, or visual director.
- Avoid overly specific implementation knobs such as exact page complexity, exact section count, exact color, or exact component lists.
- Prefer single_select and multi_select questions with 3-5 meaningful options.
- Use allowOther=true when users may add a custom option.
- Include at most one text question.
- All questions must be optional because the user may skip clarification entirely.
- The goal is to open the design space, not lock down a final spec.

Return only this machine-readable block:
<${CLARIFICATION_TAG}>
{
  "version": 1,
  "summary": "one sentence restating the request",
  "questions": [
    {
      "id": "designer_lens",
      "label": "Which design lens should lead the first exploration?",
      "why": "Different roles open different design directions.",
      "type": "multi_select",
      "required": false,
      "options": ["Interaction designer", "AI engineer", "Product strategist"],
      "allowOther": true
    }
  ],
  "assumptions": ["short assumption if the user skips the questions"]
}
</${CLARIFICATION_TAG}>`;
}

export async function generateClarificationPayload(
  description: string,
  previousExplorations: string[] = [],
): Promise<{ payload: ClarificationPayload; source: 'claude' | 'fallback'; raw?: string; error?: string }> {
  const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude';
  const timeoutMs = readPositiveInteger(process.env.CLAUDE_CLARIFICATION_TIMEOUT_MS, 120_000);
  const permissionMode = process.env.CLAUDE_CLARIFICATION_PERMISSION_MODE ?? 'acceptEdits';
  const prompt = `${buildClarificationPrompt(description, previousExplorations)}

Do not use tools. Return the tagged JSON only.`;

  try {
    const raw = await runClaude(command, ['--permission-mode', permissionMode, '-p', prompt], timeoutMs);
    return { payload: parseClarificationPayload(raw), source: 'claude', raw };
  } catch (error) {
    return {
      payload: createDefaultClarificationPayload(description),
      source: 'fallback',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseClarificationPayload(raw: string): ClarificationPayload {
  const json = extractTaggedJson(raw, CLARIFICATION_TAG) ?? extractFencedJson(raw) ?? raw.trim();
  const payload = JSON.parse(json) as unknown;
  return normalizeClarificationPayload(payload);
}

export function createDefaultClarificationPayload(description: string): ClarificationPayload {
  return {
    version: 1,
    summary: description,
    questions: [
      {
        id: 'designer_lens',
        label: 'Which perspective should lead the first exploration?',
        why: '不同角色会打开不同设计方向，而不是只收集具体页面参数。',
        type: 'multi_select',
        required: false,
        options: ['Interaction designer', 'AI engineer', 'Product strategist', 'Information architect'],
        allowOther: true,
      },
      {
        id: 'exploration_bias',
        label: 'What kind of possibility should the system explore first?',
        why: '这个问题帮助系统先发散可能性，而不是直接收敛到一个常规页面。',
        type: 'single_select',
        required: false,
        options: ['Information structure', 'Interaction flow', 'Visual tone', 'AI-assisted workflow'],
        allowOther: true,
      },
      {
        id: 'open_notes',
        label: 'Anything else you want the design agent to consider?',
        why: '可以补充偏好、反感项、参考方向，也可以留空跳过。',
        type: 'text',
        required: false,
      },
    ],
    assumptions: [
      'If unanswered, generate divergent sketch-first candidates rather than polished final pages.',
      'Each candidate should differ in architecture, logic, density, expression, and interaction.',
    ],
  };
}

function normalizeClarificationPayload(payload: unknown): ClarificationPayload {
  if (!isRecord(payload)) {
    throw new Error('Clarification payload must be an object.');
  }

  const version = payload.version;
  if (version !== 1) {
    throw new Error('Clarification payload version must be 1.');
  }

  const summary = requireString(payload.summary, 'summary');
  const questionsValue = payload.questions;
  if (!Array.isArray(questionsValue) || questionsValue.length === 0) {
    throw new Error('Clarification payload must include questions.');
  }

  return {
    version,
    summary,
    questions: questionsValue.map(normalizeQuestion),
    assumptions: Array.isArray(payload.assumptions)
      ? payload.assumptions.map((item, index) => requireString(item, `assumptions[${index}]`))
      : [],
  };
}

function normalizeQuestion(value: unknown, index: number): ClarificationQuestion {
  if (!isRecord(value)) {
    throw new Error(`questions[${index}] must be an object.`);
  }

  const type = requireString(value.type, `questions[${index}].type`);
  if (type !== 'text' && type !== 'single_select' && type !== 'multi_select') {
    throw new Error(`questions[${index}].type is invalid.`);
  }

  const options = value.options;
  return {
    id: requireString(value.id, `questions[${index}].id`),
    label: requireString(value.label, `questions[${index}].label`),
    why: requireString(value.why, `questions[${index}].why`),
    type,
    required: false,
    options: Array.isArray(options) ? options.map((item, optionIndex) => requireString(item, `questions[${index}].options[${optionIndex}]`)) : undefined,
    allowOther: Boolean(value.allowOther),
    defaultValue: normalizeDefaultValue(value.defaultValue),
  };
}

function extractTaggedJson(raw: string, tag: string): string | null {
  const match = raw.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  return match?.[1]?.trim() ?? null;
}

function extractFencedJson(raw: string): string | null {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return match?.[1]?.trim() ?? null;
}

function normalizeDefaultValue(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => requireString(item, `defaultValue[${index}]`));
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }

  return value.trim();
}

function runClaude(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Claude clarification timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

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
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`Claude clarification exited with code ${code}: ${stderr}`));
        return;
      }

      resolve(stdout);
    });
  });
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
