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

const currentState: ClientState = {
  id: '',
  round: 0,
  phase: 'explore',
  variants: [],
  scores: {},
  description: '',
};

let currentModalVariant: Variant | null = null;

const startScreen = query<HTMLElement>('start-screen');
const galleryScreen = query<HTMLElement>('gallery-screen');
const loadingOverlay = query<HTMLElement>('loading-overlay');
const modalOverlay = query<HTMLElement>('modal-overlay');
const explorationsPanel = query<HTMLElement>('explorations-panel');
const explorationsList = query<HTMLElement>('explorations-list');
const descriptionInput = query<HTMLInputElement>('description-input');
const startBtn = query<HTMLButtonElement>('start-btn');
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
  startExploration().catch(showError);
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

async function startExploration(): Promise<void> {
  const description = descriptionInput.value.trim();
  if (!description) {
    alert('Description is required.');
    return;
  }

  showLoading();

  try {
    const state = await requestJson<ExplorerState>('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });

    applyServerState(state);
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
  showLoading();

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
  showLoading();

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

function showLoading(): void {
  loadingOverlay.classList.remove('hidden');
}

function hideLoading(): void {
  loadingOverlay.classList.add('hidden');
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
