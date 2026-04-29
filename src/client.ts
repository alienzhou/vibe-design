type Phase = 'explore' | 'converge' | 'finalized';
type Rating = 0 | 1 | 2 | 3 | 4 | 5;

interface Variant {
  id: string;
  round: number;
  filename: string;
  path: string;
}

interface Score {
  variantId: string;
  rating: Rating;
  timestamp: number;
}

interface ExplorerState {
  id: string;
  round: number;
  phase: Phase;
  variants: Variant[];
  scores: Score[];
  userDescription: string;
  finalOutputPath?: string;
}

interface ClientState {
  id: string;
  round: number;
  phase: Phase;
  variants: Variant[];
  scores: Record<string, Rating>;
  description: string;
  finalOutputPath?: string;
}

interface ExplorationSummary {
  id: string;
  description: string;
  round: number;
  phase: Phase;
  createdAt: number;
  updatedAt: number;
}

type ClarificationQuestionType = 'text' | 'single_select' | 'multi_select';

interface ClarificationQuestion {
  id: string;
  label: string;
  why: string;
  type: ClarificationQuestionType;
  required: boolean;
  options?: string[];
  allowOther?: boolean;
  defaultValue?: string | string[];
}

interface ClarificationPayload {
  version: 1;
  summary: string;
  questions: ClarificationQuestion[];
  assumptions: string[];
}

type ProgressLevel = 'info' | 'warn' | 'error';
type ProgressType =
  | 'round-started'
  | 'round-completed'
  | 'variant-started'
  | 'variant-output'
  | 'variant-completed'
  | 'variant-failed'
  | 'variant-fallback';

interface GenerationProgressEvent {
  type: ProgressType;
  level: ProgressLevel;
  message: string;
  timestamp: number;
  round?: number;
  phase?: Phase;
  variantId?: string;
  stream?: 'stdout' | 'stderr';
}

interface LoadingOptions {
  title: string;
  hint: string;
  streamProgress?: boolean;
}

const currentState: ClientState = {
  id: '',
  round: 0,
  phase: 'explore',
  variants: [],
  scores: {},
  description: '',
};

let currentModalVariant: Variant | null = null;
let pendingDescription = '';
let currentClarification: ClarificationPayload | null = null;
let progressSource: EventSource | null = null;

const startScreen = query<HTMLElement>('start-screen');
const galleryScreen = query<HTMLElement>('gallery-screen');
const loadingOverlay = query<HTMLElement>('loading-overlay');
const loadingTitle = query<HTMLElement>('loading-title');
const loadingHint = query<HTMLElement>('loading-hint');
const progressPanel = query<HTMLElement>('progress-panel');
const progressList = query<HTMLElement>('progress-list');
const modalOverlay = query<HTMLElement>('modal-overlay');
const clarificationPanel = query<HTMLElement>('clarification-panel');
const clarificationQuestions = query<HTMLElement>('clarification-questions');
const explorationsPanel = query<HTMLElement>('explorations-panel');
const explorationsList = query<HTMLElement>('explorations-list');
const descriptionInput = query<HTMLInputElement>('description-input');
const startBtn = query<HTMLButtonElement>('start-btn');
const submitClarificationBtn = query<HTMLButtonElement>('submit-clarification-btn');
const skipClarificationBtn = query<HTMLButtonElement>('skip-clarification-btn');
const cancelClarificationBtn = query<HTMLButtonElement>('cancel-clarification-btn');
const backToStartBtn = query<HTMLButtonElement>('back-to-start-btn');
const nextRoundBtn = query<HTMLButtonElement>('next-round-btn');
const finalizeBtn = query<HTMLButtonElement>('finalize-btn');
const phaseBadge = query<HTMLElement>('phase-badge');
const roundBadge = query<HTMLElement>('round-badge');
const currentRound = query<HTMLElement>('current-round');
const variantsGrid = query<HTMLElement>('variants-grid');
const previewFrame = query<HTMLIFrameElement>('preview-frame');
const starRating = query<HTMLElement>('star-rating');
const ratingLabel = query<HTMLElement>('rating-label');
const closeModal = query<HTMLButtonElement>('close-modal');

const ratingLabels: Record<Rating, string> = {
  0: '未评分',
  1: '不喜欢',
  2: '不太喜欢',
  3: '一般',
  4: '喜欢',
  5: '非常喜欢',
};

startBtn.addEventListener('click', () => {
  prepareClarification().catch(showError);
});

submitClarificationBtn.addEventListener('click', () => {
  startExploration().catch(showError);
});

skipClarificationBtn.addEventListener('click', () => {
  startExploration(true).catch(showError);
});

cancelClarificationBtn.addEventListener('click', () => {
  hideClarification();
  descriptionInput.focus();
});

nextRoundBtn.addEventListener('click', () => {
  nextRound().catch(showError);
});

backToStartBtn.addEventListener('click', () => {
  showStart();
  loadExplorations().catch(showError);
});

finalizeBtn.addEventListener('click', () => {
  finalizeDesign().catch(showError);
});

closeModal.addEventListener('click', closeVariantModal);

starRating.querySelectorAll<HTMLButtonElement>('.star').forEach((star, index) => {
  const rating = (index + 1) as Rating;

  star.addEventListener('click', () => {
    saveScore(rating).catch(showError);
  });

  star.addEventListener('mouseenter', () => {
    updateStarDisplay(rating, true);
  });
});

starRating.addEventListener('mouseleave', () => {
  if (!currentModalVariant) {
    return;
  }

  updateStarDisplay(currentState.scores[currentModalVariant.id] ?? 0);
});

modalOverlay.addEventListener('click', (event) => {
  if (event.target === modalOverlay) {
    closeVariantModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    closeVariantModal();
  }
});

loadExplorations().catch(showError);

async function prepareClarification(): Promise<void> {
  const description = descriptionInput.value.trim();
  if (!description) {
    alert('Description is required.');
    return;
  }

  pendingDescription = description;
  showLoading({
    title: '正在梳理需求...',
    hint: 'AI 正在判断还需要补充哪些关键信息',
  });

  try {
    const data = await requestJson<{ payload: ClarificationPayload; source: 'claude' | 'fallback' }>('/api/clarify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    currentClarification = data.payload;
    renderClarification(data.payload);
  } finally {
    hideLoading();
  }
}

async function startExploration(skipClarification = false): Promise<void> {
  if (!currentClarification) {
    await prepareClarification();
    return;
  }

  const answers = skipClarification ? {} : collectClarificationAnswers(currentClarification);
  if (!answers) {
    return;
  }

  const description = buildClarifiedDescription(pendingDescription, currentClarification, answers);
  showLoading({
    title: '正在生成设计变体...',
    hint: '正在启动 Claude Code worker...',
    streamProgress: true,
  });

  try {
    const state = await requestJson<ExplorerState>('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });

    applyServerState(state);
    hideClarification();
    showGallery();
    render();
  } finally {
    hideLoading();
  }
}

async function loadExplorations(): Promise<void> {
  const data = await requestJson<{ explorations: ExplorationSummary[] }>('/api/explorations');
  renderExplorations(data.explorations);
}

async function selectExploration(id: string): Promise<void> {
  showLoading({
    title: '正在打开探索...',
    hint: '正在加载历史变体',
  });

  try {
    const state = await requestJson<ExplorerState>(`/api/explorations/${encodeURIComponent(id)}/select`, {
      method: 'POST',
    });
    applyServerState(state);
    showGallery();
    render();
  } finally {
    hideLoading();
  }
}

async function saveScore(rating: Rating): Promise<void> {
  if (!currentModalVariant) {
    return;
  }

  currentState.scores[currentModalVariant.id] = rating;
  updateStarDisplay(rating);
  updateVariantCardRating(currentModalVariant.id, rating);
  updateActionButtons();

  await requestJson<{ scores: Score[] }>('/api/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variantId: currentModalVariant.id, rating }),
  });
}

async function nextRound(): Promise<void> {
  showLoading({
    title: '正在生成下一轮...',
    hint: 'AI 正在结合评分反馈继续探索',
    streamProgress: true,
  });

  try {
    const state = await requestJson<ExplorerState>('/api/next-round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    applyServerState(state);
    closeVariantModal();
    render();
  } finally {
    hideLoading();
  }
}

async function finalizeDesign(): Promise<void> {
  const variantId = pickHighestRatedVariant();
  if (!variantId) {
    alert('Please score at least one variant before finalizing.');
    return;
  }

  const state = await requestJson<ExplorerState>('/api/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variantId }),
  });

  applyServerState(state);
  render();
  alert(`Final design exported: ${state.finalOutputPath ?? '/workspace/output/final.html'}`);
}

function render(): void {
  updatePhaseDisplay();
  renderVariants();
  updateActionButtons();
}

function renderExplorations(explorations: ExplorationSummary[]): void {
  explorationsPanel.classList.toggle('hidden', explorations.length === 0);
  explorationsList.innerHTML = '';

  explorations.forEach((exploration) => {
    const item = document.createElement('div');
    item.className = 'exploration-item';
    item.innerHTML = `
      <div>
        <div class="exploration-title">${escapeHtml(exploration.description || '未命名探索')}</div>
        <div class="exploration-meta">
          Round ${exploration.round} · ${phaseLabel(exploration.phase)} · ${formatDate(exploration.updatedAt)}
        </div>
      </div>
      <button class="btn-secondary" type="button">继续</button>
    `;

    item.querySelector('button')?.addEventListener('click', () => {
      selectExploration(exploration.id).catch(showError);
    });
    explorationsList.appendChild(item);
  });
}

function renderClarification(payload: ClarificationPayload): void {
  clarificationQuestions.innerHTML = '';

  payload.questions.forEach((question) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'clarification-question';
    wrapper.dataset.questionId = question.id;
    wrapper.innerHTML = `
      <label>${escapeHtml(question.label)}${question.required ? ' *' : ''}</label>
      <p class="why">${escapeHtml(question.why)}</p>
      ${renderQuestionInput(question)}
    `;
    clarificationQuestions.appendChild(wrapper);
  });

  clarificationPanel.classList.remove('hidden');
  explorationsPanel.classList.add('hidden');
}

function renderVariants(): void {
  variantsGrid.innerHTML = '';

  currentState.variants.forEach((variant, index) => {
    const card = document.createElement('div');
    card.className = 'variant-card';
    card.dataset.id = variant.id;

    const rating = currentState.scores[variant.id] ?? 0;
    const iframe = `${variant.path}?v=${variant.round}`;

    card.innerHTML = `
      <div class="variant-preview">
        <iframe title="设计变体 ${index + 1}" src="${iframe}"></iframe>
      </div>
      <div class="variant-info">
        <div class="variant-title">变体 ${index + 1}</div>
        <div class="variant-rating" data-rating="${rating}">
          ${renderStars(rating)}
        </div>
      </div>
    `;

    card.addEventListener('click', () => openVariantModal(variant));
    variantsGrid.appendChild(card);
  });
}

function renderStars(rating: Rating): string {
  return Array.from({ length: 5 }, (_, index) =>
    `<span class="star ${index < rating ? 'active' : ''}">★</span>`,
  ).join('');
}

function openVariantModal(variant: Variant): void {
  currentModalVariant = variant;
  updateStarDisplay(currentState.scores[variant.id] ?? 0);
  previewFrame.removeAttribute('srcdoc');
  previewFrame.src = `${variant.path}?v=${variant.round}`;
  modalOverlay.classList.remove('hidden');
}

function closeVariantModal(): void {
  modalOverlay.classList.add('hidden');
  currentModalVariant = null;
  previewFrame.removeAttribute('src');
}

function updateStarDisplay(rating: Rating, isHover = false): void {
  starRating.querySelectorAll<HTMLElement>('.star').forEach((star, index) => {
    star.classList.toggle('active', index < rating);
  });

  ratingLabel.textContent = ratingLabels[rating];
  ratingLabel.style.color = isHover ? '#fbbf24' : '#fff';
}

function updateVariantCardRating(variantId: string, rating: Rating): void {
  const card = document.querySelector<HTMLElement>(`[data-id="${variantId}"]`);
  const ratingContainer = card?.querySelector<HTMLElement>('.variant-rating');

  if (ratingContainer) {
    ratingContainer.innerHTML = renderStars(rating);
  }
}

function updateActionButtons(): void {
  const scoredCount = Object.keys(currentState.scores).length;

  nextRoundBtn.disabled = scoredCount === 0 || currentState.phase === 'finalized';
  nextRoundBtn.textContent = scoredCount > 0
    ? `下一轮探索 (${scoredCount}/${currentState.variants.length} 已评分) →`
    : '请先为设计打分';

  finalizeBtn.classList.toggle('hidden', currentState.phase !== 'converge' || scoredCount === 0);
}

function updatePhaseDisplay(): void {
  phaseBadge.textContent = `Phase: ${phaseLabel(currentState.phase)}`;
  roundBadge.textContent = `Round ${currentState.round}`;
  currentRound.textContent = String(currentState.round);
}

function applyServerState(state: ExplorerState): void {
  currentState.id = state.id;
  currentState.round = state.round;
  currentState.phase = state.phase;
  currentState.variants = state.variants;
  currentState.description = state.userDescription;
  currentState.finalOutputPath = state.finalOutputPath;
  currentState.scores = Object.fromEntries(state.scores.map((score) => [score.variantId, score.rating]));
}

function pickHighestRatedVariant(): string | null {
  const entries = Object.entries(currentState.scores);
  if (entries.length === 0) {
    return null;
  }

  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function showGallery(): void {
  startScreen.classList.add('hidden');
  galleryScreen.classList.remove('hidden');
}

function showStart(): void {
  closeVariantModal();
  galleryScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');
}

function hideClarification(): void {
  clarificationPanel.classList.add('hidden');
  clarificationQuestions.innerHTML = '';
  currentClarification = null;
  pendingDescription = '';
  loadExplorations().catch(showError);
}

function showLoading(options: LoadingOptions): void {
  loadingTitle.textContent = options.title;
  loadingHint.textContent = options.hint;
  progressList.innerHTML = '';
  progressPanel.classList.toggle('hidden', !options.streamProgress);
  loadingOverlay.classList.remove('hidden');
  if (options.streamProgress) {
    openProgressStream();
  } else {
    closeProgressStream();
  }
}

function hideLoading(): void {
  closeProgressStream();
  loadingOverlay.classList.add('hidden');
}

function openProgressStream(): void {
  closeProgressStream();
  progressPanel.classList.remove('hidden');
  appendProgressEvent({
    type: 'round-started',
    level: 'info',
    message: '正在连接生成进度...',
    timestamp: Date.now(),
  });

  progressSource = new EventSource('/api/progress');
  progressSource.addEventListener('progress', (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as GenerationProgressEvent;
    renderProgressEvent(payload);
  });
  progressSource.onerror = () => {
    loadingHint.textContent = '进度连接暂时中断，最终结果仍会在生成完成后返回';
  };
}

function closeProgressStream(): void {
  progressSource?.close();
  progressSource = null;
}

function renderProgressEvent(event: GenerationProgressEvent): void {
  loadingHint.textContent = progressHint(event);
  appendProgressEvent(event);
}

function appendProgressEvent(event: GenerationProgressEvent): void {
  const item = document.createElement('div');
  item.className = 'progress-item';
  item.dataset.level = event.level;
  item.innerHTML = `
    <div class="progress-item-status">${escapeHtml(progressStatus(event))}</div>
    <div class="progress-message">${escapeHtml(progressMessage(event))}</div>
  `;
  progressList.appendChild(item);

  while (progressList.children.length > 80) {
    progressList.firstElementChild?.remove();
  }

  progressList.scrollTop = progressList.scrollHeight;
}

function progressStatus(event: GenerationProgressEvent): string {
  if (event.variantId) {
    return event.variantId;
  }

  if (typeof event.round === 'number') {
    return `round ${event.round}`;
  }

  return event.level;
}

function progressMessage(event: GenerationProgressEvent): string {
  const prefix = event.stream ? `[${event.stream}] ` : '';
  return `${prefix}${event.message}`;
}

function progressHint(event: GenerationProgressEvent): string {
  if (event.type === 'round-completed') {
    return '设计变体生成完成，正在刷新页面';
  }

  if (event.type === 'variant-output' && event.variantId) {
    return `${event.variantId} 正在输出内容`;
  }

  if (event.type === 'variant-started' && event.variantId) {
    return `${event.variantId} 已开始生成`;
  }

  if (event.type === 'variant-completed' && event.variantId) {
    return `${event.variantId} 已完成`;
  }

  return event.message;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as unknown;

  if (!response.ok) {
    throw new Error(readErrorMessage(payload) ?? `Request failed with ${response.status}.`);
  }

  return payload as T;
}

function readErrorMessage(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    return typeof error === 'string' ? error : null;
  }

  return null;
}

function renderQuestionInput(question: ClarificationQuestion): string {
  if (question.type === 'single_select') {
    return `
      <select data-question-input="${escapeHtml(question.id)}">
        <option value="">请选择</option>
        ${(question.options ?? []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}
      </select>
      ${renderOtherInput(question)}
    `;
  }

  if (question.type === 'multi_select') {
    return `
      <div class="clarification-options" data-question-input="${escapeHtml(question.id)}">
        ${(question.options ?? []).map((option) => `
          <label class="clarification-option">
            <input type="checkbox" value="${escapeHtml(option)}">
            <span>${escapeHtml(option)}</span>
          </label>
        `).join('')}
      </div>
      ${renderOtherInput(question)}
    `;
  }

  const defaultValue = typeof question.defaultValue === 'string' ? question.defaultValue : '';
  return `<input data-question-input="${escapeHtml(question.id)}" type="text" value="${escapeHtml(defaultValue)}" placeholder="请输入">`;
}

function renderOtherInput(question: ClarificationQuestion): string {
  if (!question.allowOther) {
    return '';
  }

  return `<input data-question-other="${escapeHtml(question.id)}" type="text" placeholder="其他补充，可留空">`;
}

function collectClarificationAnswers(payload: ClarificationPayload): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of payload.questions) {
    const answer = readQuestionAnswer(question);
    const isEmpty = Array.isArray(answer) ? answer.length === 0 : answer.trim().length === 0;

    if (question.required && isEmpty) {
      alert(`请回答：${question.label}`);
      return null;
    }

    if (!isEmpty) {
      answers[question.id] = answer;
    }
  }

  return answers;
}

function readQuestionAnswer(question: ClarificationQuestion): string | string[] {
  const selector = `[data-question-input="${cssEscape(question.id)}"]`;
  const element = clarificationQuestions.querySelector<HTMLElement>(selector);

  if (!element) {
    return question.type === 'multi_select' ? [] : '';
  }

  if (question.type === 'multi_select') {
    const values = Array.from(element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map((input) => input.value);
    const other = readOtherAnswer(question.id);
    return other ? [...values, `Other: ${other}`] : values;
  }

  const value = (element as HTMLInputElement | HTMLSelectElement).value.trim();
  const other = readOtherAnswer(question.id);
  return other ? [value, `Other: ${other}`].filter(Boolean).join(', ') : value;
}

function readOtherAnswer(questionId: string): string {
  return clarificationQuestions.querySelector<HTMLInputElement>(`[data-question-other="${cssEscape(questionId)}"]`)?.value.trim() ?? '';
}

function buildClarifiedDescription(
  description: string,
  payload: ClarificationPayload,
  answers: Record<string, string | string[]>,
): string {
  const lines = Object.entries(answers).map(([id, value]) => {
    const question = payload.questions.find((item) => item.id === id);
    const label = question?.label ?? id;
    const text = Array.isArray(value) ? value.join(', ') : value;
    return `- ${label}: ${text}`;
  });

  return [
    description,
    '',
    'Clarification answers:',
    ...lines,
    '',
    'Assumptions:',
    ...payload.assumptions.map((assumption) => `- ${assumption}`),
  ].join('\n');
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, '\\$&');
}

function phaseLabel(phase: Phase): string {
  const phaseText: Record<Phase, string> = {
    explore: '探索',
    converge: '对战',
    finalized: '已定稿',
  };

  return phaseText[phase];
}

function formatDate(timestamp: number): string {
  if (!timestamp) {
    return '未知时间';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
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

function query<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }

  return element as T;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown error.';
  console.error('Design Explorer error:', error);
  hideLoading();
  alert(message);
}
