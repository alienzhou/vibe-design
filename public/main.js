// State
let currentState = {
  round: 0,
  phase: 'explore',
  variants: [],
  scores: {},
  description: ''
};

let currentModalVariant = null;

// DOM Elements
const startScreen = document.getElementById('start-screen');
const galleryScreen = document.getElementById('gallery-screen');
const loadingOverlay = document.getElementById('loading-overlay');
const modalOverlay = document.getElementById('modal-overlay');

const descriptionInput = document.getElementById('description-input');
const startBtn = document.getElementById('start-btn');
const nextRoundBtn = document.getElementById('next-round-btn');
const finalizeBtn = document.getElementById('finalize-btn');

const phaseBadge = document.getElementById('phase-badge');
const roundBadge = document.getElementById('round-badge');
const variantsGrid = document.getElementById('variants-grid');

const previewFrame = document.getElementById('preview-frame');
const starRating = document.getElementById('star-rating');
const ratingLabel = document.getElementById('rating-label');
const closeModal = document.getElementById('close-modal');

// Rating labels
const ratingLabels = {
  0: '未评分',
  1: '不喜欢',
  2: '不太喜欢',
  3: '一般',
  4: '喜欢',
  5: '非常喜欢'
};

// Event Listeners
startBtn.addEventListener('click', startExploration);
nextRoundBtn.addEventListener('click', nextRound);
closeModal.addEventListener('click', closeVariantModal);

// Star rating
starRating.querySelectorAll('.star').forEach((star, index) => {
  star.addEventListener('click', () => {
    if (!currentModalVariant) return;
    const rating = index + 1;
    currentState.scores[currentModalVariant.id] = rating;
    updateStarDisplay(rating);
    updateVariantCardRating(currentModalVariant.id, rating);
    updateNextButton();
  });

  star.addEventListener('mouseenter', () => {
    updateStarDisplay(index + 1, true);
  });
});

starRating.addEventListener('mouseleave', () => {
  if (currentModalVariant) {
    const rating = currentState.scores[currentModalVariant.id] || 0;
    updateStarDisplay(rating);
  }
});

// Functions
async function startExploration() {
  const description = descriptionInput.value.trim();
  if (!description) {
    alert('请输入设计描述');
    return;
  }

  currentState.description = description;
  showLoading();

  try {
    const response = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description })
    });

    const data = await response.json();
    currentState.round = data.round;

    // 模拟生成变体（实际应该等待生成完成）
    await generateMockVariants();

    hideLoading();
    showGallery();
    await loadVariants();
  } catch (error) {
    console.error('Start failed:', error);
    hideLoading();
    alert('启动失败: ' + error.message);
  }
}

async function generateMockVariants() {
  // 模拟生成延迟
  await new Promise(resolve => setTimeout(resolve, 1500));

  // 创建模拟变体
  const roundDir = `workspace/round-1`;
  const mockVariants = [
    { id: 'variant-1', name: '极简白色', style: 'minimal-white' },
    { id: 'variant-2', name: '深色科技', style: 'dark-tech' },
    { id: 'variant-3', name: '渐变活力', style: 'gradient-vibrant' },
    { id: 'variant-4', name: '柔和自然', style: 'soft-nature' },
    { id: 'variant-5', name: '商务专业', style: 'business-pro' },
    { id: 'variant-6', name: '创意大胆', style: 'creative-bold' }
  ];

  // 这里应该实际调用后端生成
  // 为了演示，先创建简单的模拟 HTML
  for (const variant of mockVariants) {
    const html = generateMockHTML(variant);
    await saveVariantFile(1, `${variant.id}.html`, html);
  }
}

function generateMockHTML(variant) {
  const styles = {
    'minimal-white': { bg: '#fff', text: '#000', accent: '#333' },
    'dark-tech': { bg: '#0f0f0f', text: '#fff', accent: '#00ff88' },
    'gradient-vibrant': { bg: 'linear-gradient(135deg, #667eea, #764ba2)', text: '#fff', accent: '#fff' },
    'soft-nature': { bg: '#f5f5f0', text: '#2d3436', accent: '#6c5ce7' },
    'business-pro': { bg: '#f8f9fa', text: '#212529', accent: '#0066cc' },
    'creative-bold': { bg: '#1a1a2e', text: '#eee', accent: '#e94560' }
  };

  const s = styles[variant.style] || styles['minimal-white'];

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, sans-serif;
      background: ${s.bg};
      color: ${s.text};
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
    }
    .container {
      max-width: 800px;
      text-align: center;
    }
    h1 {
      font-size: 48px;
      font-weight: 700;
      margin-bottom: 24px;
      letter-spacing: -1px;
    }
    p {
      font-size: 18px;
      opacity: 0.8;
      margin-bottom: 40px;
      line-height: 1.6;
    }
    .cta {
      display: inline-block;
      padding: 16px 32px;
      background: ${s.accent};
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      margin-top: 60px;
    }
    .feature {
      padding: 24px;
      background: rgba(0,0,0,0.05);
      border-radius: 12px;
    }
    .feature h3 {
      font-size: 18px;
      margin-bottom: 8px;
    }
    .feature p {
      font-size: 14px;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${currentState.description || 'SaaS Pricing'}</h1>
    <p>简洁、高效的设计方案，为您的业务带来全新体验</p>
    <a href="#" class="cta">开始使用</a>
    <div class="features">
      <div class="feature">
        <h3>快速</h3>
        <p>毫秒级响应</p>
      </div>
      <div class="feature">
        <h3>安全</h3>
        <p>企业级保护</p>
      </div>
      <div class="feature">
        <h3>智能</h3>
        <p>AI 驱动</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function saveVariantFile(round, filename, content) {
  // 实际应该通过后端 API 保存
  // 这里简化处理
}

async function loadVariants() {
  try {
    const response = await fetch('/api/variants');
    const data = await response.json();

    currentState.variants = data.variants;
    currentState.round = data.round;
    currentState.phase = data.phase;

    updatePhaseDisplay();
    renderVariants();
  } catch (error) {
    console.error('Load variants failed:', error);
    // 使用模拟数据
    currentState.variants = [
      { id: 'variant-1', name: '极简白色', path: '#' },
      { id: 'variant-2', name: '深色科技', path: '#' },
      { id: 'variant-3', name: '渐变活力', path: '#' },
      { id: 'variant-4', name: '柔和自然', path: '#' },
      { id: 'variant-5', name: '商务专业', path: '#' },
      { id: 'variant-6', name: '创意大胆', path: '#' }
    ];
    renderVariants();
  }
}

function renderVariants() {
  variantsGrid.innerHTML = '';

  currentState.variants.forEach((variant, index) => {
    const card = document.createElement('div');
    card.className = 'variant-card';
    card.dataset.id = variant.id;

    const rating = currentState.scores[variant.id] || 0;

    card.innerHTML = `
      <div class="variant-preview">
        <iframe srcdoc="${generateMockHTML({ style: getStyleByIndex(index) }).replace(/"/g, '&quot;')}"></iframe>
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

function getStyleByIndex(index) {
  const styles = ['minimal-white', 'dark-tech', 'gradient-vibrant', 'soft-nature', 'business-pro', 'creative-bold'];
  return styles[index % styles.length];
}

function renderStars(rating) {
  return Array(5).fill(0).map((_, i) =>
    `<span class="star ${i < rating ? 'active' : ''}">★</span>`
  ).join('');
}

function openVariantModal(variant) {
  currentModalVariant = variant;
  const rating = currentState.scores[variant.id] || 0;

  updateStarDisplay(rating);
  previewFrame.srcdoc = generateMockHTML({ style: getStyleByIndex(parseInt(variant.id.split('-')[1]) - 1) });

  modalOverlay.classList.remove('hidden');
}

function closeVariantModal() {
  modalOverlay.classList.add('hidden');
  currentModalVariant = null;
}

function updateStarDisplay(rating, isHover = false) {
  const stars = starRating.querySelectorAll('.star');
  stars.forEach((star, index) => {
    star.classList.toggle('active', index < rating);
  });

  ratingLabel.textContent = ratingLabels[rating] || '';
  ratingLabel.style.color = isHover ? '#fbbf24' : '#fff';
}

function updateVariantCardRating(variantId, rating) {
  const card = document.querySelector(`[data-id="${variantId}"]`);
  if (card) {
    const ratingContainer = card.querySelector('.variant-rating');
    ratingContainer.innerHTML = renderStars(rating);
  }
}

function updateNextButton() {
  const scoredCount = Object.keys(currentState.scores).length;
  nextRoundBtn.disabled = scoredCount === 0;
  nextRoundBtn.textContent = scoredCount > 0
    ? `下一轮探索 (${scoredCount}/${currentState.variants.length} 已评分) →`
    : '请先为设计打分';
}

async function nextRound() {
  showLoading();

  try {
    const response = await fetch('/api/next-round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const data = await response.json();
    currentState.round = data.round;
    currentState.phase = data.phase;
    currentState.scores = {};

    await generateMockVariants();

    hideLoading();
    await loadVariants();
    updateNextButton();
  } catch (error) {
    console.error('Next round failed:', error);
    hideLoading();
  }
}

function updatePhaseDisplay() {
  phaseBadge.textContent = `Phase: ${currentState.phase === 'explore' ? '探索' : '对战'}`;
  roundBadge.textContent = `Round ${currentState.round}`;
}

function showGallery() {
  startScreen.classList.add('hidden');
  galleryScreen.classList.remove('hidden');
}

function showLoading() {
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// Close modal on outside click
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    closeVariantModal();
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    closeVariantModal();
  }
});

// Initialize
updateNextButton();
