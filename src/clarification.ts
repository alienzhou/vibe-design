import type { ClarificationPayload, ClarificationQuestion } from './types.js';

export const CLARIFICATION_TAG = 'design-explorer-clarification';

export function buildClarificationPrompt(description: string): string {
  return `You are preparing a sketch-first design exploration.

User request:
${description}

Ask 3-5 high-signal questions before generating variants. The questions should help identify reader/user, supported decision, required content, desired experience, and exclusions.

Return only this machine-readable block:
<${CLARIFICATION_TAG}>
{
  "version": 1,
  "summary": "one sentence restating the request",
  "questions": [
    {
      "id": "target_reader",
      "label": "Who will read or use this page?",
      "why": "This decides whether the first screen should prioritize conclusion, analysis, operation, or reporting.",
      "type": "text",
      "required": true
    }
  ],
  "assumptions": ["short assumption if the user skips the questions"]
}
</${CLARIFICATION_TAG}>`;
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
        id: 'target_reader',
        label: 'Who is the primary reader or user?',
        why: 'The reader determines whether the design should lead with conclusions, evidence, operations, or decisions.',
        type: 'text',
        required: true,
      },
      {
        id: 'supported_action',
        label: 'What decision or action should the page support?',
        why: 'The action defines the page hierarchy and the main call to action.',
        type: 'text',
        required: true,
      },
      {
        id: 'required_content',
        label: 'What content, data, or modules must appear?',
        why: 'Required modules prevent the variants from becoming generic landing pages.',
        type: 'text',
        required: true,
      },
      {
        id: 'experience_mode',
        label: 'Which experience should it lean toward?',
        why: 'This guides the architecture and interaction model.',
        type: 'multi_select',
        required: false,
        options: ['reading', 'comparison', 'diagnosis', 'operation', 'reporting'],
      },
      {
        id: 'avoid',
        label: 'What styles, structures, or content should be avoided?',
        why: 'Exclusions reduce wasted exploration directions.',
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
    required: Boolean(value.required),
    options: Array.isArray(options) ? options.map((item, optionIndex) => requireString(item, `questions[${index}].options[${optionIndex}]`)) : undefined,
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
