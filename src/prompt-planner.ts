import { buildGenerationPrompt, variantCountForPhase } from './explorer.js';
import type { CandidateAxes, GenerationRequest, VariantPromptPlan } from './types.js';

const DIVERGENT_AXES: Array<Omit<VariantPromptPlan, 'variantId' | 'outputFile' | 'prompt'>> = [
  {
    title: 'Research Narrative',
    hypothesis: 'Explain the product or report through a conclusion-first narrative with evidence and recommendations.',
    axes: {
      architecture: 'multi-section report',
      logic: 'conclusion first, evidence later',
      density: 'medium',
      expression: 'formal research report',
      interaction: 'reading and exporting',
    },
  },
  {
    title: 'Comparison Matrix',
    hypothesis: 'Make differences visible through a matrix-first structure and side-by-side evidence.',
    axes: {
      architecture: 'comparison board',
      logic: 'comparison first',
      density: 'dense professional tooling',
      expression: 'data product',
      interaction: 'filtering and drilling down',
    },
  },
  {
    title: 'Command Center',
    hypothesis: 'Treat the page as an operational cockpit where status, risk, and next action are immediately visible.',
    axes: {
      architecture: 'dashboard cockpit',
      logic: 'task-oriented',
      density: 'high',
      expression: 'management board',
      interaction: 'monitoring and diagnosis',
    },
  },
  {
    title: 'Consulting Deck',
    hypothesis: 'Use presentation-like sections so stakeholders can quickly understand storyline, tradeoffs, and decisions.',
    axes: {
      architecture: 'slide-like storytelling',
      logic: 'narrative',
      density: 'lightweight reading',
      expression: 'consulting deck',
      interaction: 'browsing and presenting',
    },
  },
  {
    title: 'Workflow Map',
    hypothesis: 'Represent the experience as a process map that emphasizes stages, handoffs, and branching decisions.',
    axes: {
      architecture: 'workflow',
      logic: 'process-driven',
      density: 'medium',
      expression: 'system diagram',
      interaction: 'annotating and collaboration',
    },
  },
  {
    title: 'Experimental Sketch',
    hypothesis: 'Open visual possibilities with a less conventional structure while keeping the information hierarchy readable.',
    axes: {
      architecture: 'asymmetric sketch board',
      logic: 'exploration-first',
      density: 'medium',
      expression: 'experimental sketch',
      interaction: 'browsing and collecting ideas',
    },
  },
];

export function buildVariantPromptPlans(request: GenerationRequest): VariantPromptPlan[] {
  const count = variantCountForPhase(request.phase);
  const basePrompt = buildGenerationPrompt(request.description, request.round, request.phase, request.previousScores);
  const axes = request.phase === 'converge' ? convergentAxes() : DIVERGENT_AXES;

  return axes.slice(0, count).map((direction, index) => {
    const variantId = `variant-${index + 1}`;
    const outputFile = `${variantId}.html`;

    return {
      ...direction,
      variantId,
      outputFile,
      prompt: buildSingleVariantPrompt({
        basePrompt,
        description: request.description,
        round: request.round,
        direction,
        outputFile,
      }),
    };
  });
}

function buildSingleVariantPrompt(input: {
  basePrompt: string;
  description: string;
  round: number;
  direction: Omit<VariantPromptPlan, 'variantId' | 'outputFile' | 'prompt'>;
  outputFile: string;
}): string {
  const axesText = renderAxes(input.direction.axes);

  return `${input.basePrompt}

You are generating exactly one variant in an isolated Claude Code worker.

Variant direction:
- title: ${input.direction.title}
- hypothesis: ${input.direction.hypothesis}
${axesText}

Sketch-first output rules:
- Write exactly one complete standalone HTML file named ${input.outputFile}.
- The HTML should include one polished core page that clearly shows the design direction.
- Also include lightweight ASCII/page-map sections inside the page to show surrounding pages, layout logic, or interactions.
- Make structural choices obvious: navigation, information architecture, content hierarchy, report modules, and interaction model should differ from other variants.
- Do not create a generic SaaS landing page. Do not rely on color changes as the primary difference.
- Use realistic content derived from the user request: "${input.description}".

Save the file in the current working directory.`;
}

function convergentAxes(): Array<Omit<VariantPromptPlan, 'variantId' | 'outputFile' | 'prompt'>> {
  return [
    {
      title: 'Refined Candidate',
      hypothesis: 'Preserve the strongest selected direction and improve fidelity.',
      axes: {
        architecture: 'selected candidate architecture',
        logic: 'selected candidate logic',
        density: 'balanced',
        expression: 'polished product quality',
        interaction: 'core interaction refinement',
      },
    },
    {
      title: 'Opposing Detail Pass',
      hypothesis: 'Keep the selected direction but explore an opposite detail treatment to avoid premature convergence.',
      axes: {
        architecture: 'selected candidate architecture',
        logic: 'selected candidate logic',
        density: 'contrasting density',
        expression: 'controlled contrast',
        interaction: 'same task with different emphasis',
      },
    },
  ];
}

function renderAxes(axes: CandidateAxes): string {
  return [
    '- axes:',
    `  - architecture: ${axes.architecture}`,
    `  - logic: ${axes.logic}`,
    `  - density: ${axes.density}`,
    `  - expression: ${axes.expression}`,
    `  - interaction: ${axes.interaction}`,
  ].join('\n');
}
