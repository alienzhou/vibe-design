"use strict";
(() => {
  // src/client.ts
  var currentState = {
    id: "",
    round: 0,
    phase: "explore",
    variants: [],
    scores: {},
    description: ""
  };
  var currentModalVariant = null;
  var pendingDescription = "";
  var currentClarification = null;
  var startScreen = query("start-screen");
  var galleryScreen = query("gallery-screen");
  var loadingOverlay = query("loading-overlay");
  var modalOverlay = query("modal-overlay");
  var clarificationPanel = query("clarification-panel");
  var clarificationQuestions = query("clarification-questions");
  var explorationsPanel = query("explorations-panel");
  var explorationsList = query("explorations-list");
  var descriptionInput = query("description-input");
  var startBtn = query("start-btn");
  var submitClarificationBtn = query("submit-clarification-btn");
  var skipClarificationBtn = query("skip-clarification-btn");
  var cancelClarificationBtn = query("cancel-clarification-btn");
  var backToStartBtn = query("back-to-start-btn");
  var nextRoundBtn = query("next-round-btn");
  var finalizeBtn = query("finalize-btn");
  var phaseBadge = query("phase-badge");
  var roundBadge = query("round-badge");
  var currentRound = query("current-round");
  var variantsGrid = query("variants-grid");
  var previewFrame = query("preview-frame");
  var starRating = query("star-rating");
  var ratingLabel = query("rating-label");
  var closeModal = query("close-modal");
  var ratingLabels = {
    0: "\u672A\u8BC4\u5206",
    1: "\u4E0D\u559C\u6B22",
    2: "\u4E0D\u592A\u559C\u6B22",
    3: "\u4E00\u822C",
    4: "\u559C\u6B22",
    5: "\u975E\u5E38\u559C\u6B22"
  };
  startBtn.addEventListener("click", () => {
    prepareClarification().catch(showError);
  });
  submitClarificationBtn.addEventListener("click", () => {
    startExploration().catch(showError);
  });
  skipClarificationBtn.addEventListener("click", () => {
    startExploration(true).catch(showError);
  });
  cancelClarificationBtn.addEventListener("click", () => {
    hideClarification();
    descriptionInput.focus();
  });
  nextRoundBtn.addEventListener("click", () => {
    nextRound().catch(showError);
  });
  backToStartBtn.addEventListener("click", () => {
    showStart();
    loadExplorations().catch(showError);
  });
  finalizeBtn.addEventListener("click", () => {
    finalizeDesign().catch(showError);
  });
  closeModal.addEventListener("click", closeVariantModal);
  starRating.querySelectorAll(".star").forEach((star, index) => {
    const rating = index + 1;
    star.addEventListener("click", () => {
      saveScore(rating).catch(showError);
    });
    star.addEventListener("mouseenter", () => {
      updateStarDisplay(rating, true);
    });
  });
  starRating.addEventListener("mouseleave", () => {
    if (!currentModalVariant) {
      return;
    }
    updateStarDisplay(currentState.scores[currentModalVariant.id] ?? 0);
  });
  modalOverlay.addEventListener("click", (event) => {
    if (event.target === modalOverlay) {
      closeVariantModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modalOverlay.classList.contains("hidden")) {
      closeVariantModal();
    }
  });
  loadExplorations().catch(showError);
  async function prepareClarification() {
    const description = descriptionInput.value.trim();
    if (!description) {
      alert("Description is required.");
      return;
    }
    pendingDescription = description;
    showLoading();
    try {
      const data = await requestJson("/api/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description })
      });
      currentClarification = data.payload;
      renderClarification(data.payload);
    } finally {
      hideLoading();
    }
  }
  async function startExploration(skipClarification = false) {
    if (!currentClarification) {
      await prepareClarification();
      return;
    }
    const answers = skipClarification ? {} : collectClarificationAnswers(currentClarification);
    if (!answers) {
      return;
    }
    const description = buildClarifiedDescription(pendingDescription, currentClarification, answers);
    showLoading();
    try {
      const state = await requestJson("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description })
      });
      applyServerState(state);
      hideClarification();
      showGallery();
      render();
    } finally {
      hideLoading();
    }
  }
  async function loadExplorations() {
    const data = await requestJson("/api/explorations");
    renderExplorations(data.explorations);
  }
  async function selectExploration(id) {
    showLoading();
    try {
      const state = await requestJson(`/api/explorations/${encodeURIComponent(id)}/select`, {
        method: "POST"
      });
      applyServerState(state);
      showGallery();
      render();
    } finally {
      hideLoading();
    }
  }
  async function saveScore(rating) {
    if (!currentModalVariant) {
      return;
    }
    currentState.scores[currentModalVariant.id] = rating;
    updateStarDisplay(rating);
    updateVariantCardRating(currentModalVariant.id, rating);
    updateActionButtons();
    await requestJson("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId: currentModalVariant.id, rating })
    });
  }
  async function nextRound() {
    showLoading();
    try {
      const state = await requestJson("/api/next-round", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      applyServerState(state);
      closeVariantModal();
      render();
    } finally {
      hideLoading();
    }
  }
  async function finalizeDesign() {
    const variantId = pickHighestRatedVariant();
    if (!variantId) {
      alert("Please score at least one variant before finalizing.");
      return;
    }
    const state = await requestJson("/api/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId })
    });
    applyServerState(state);
    render();
    alert(`Final design exported: ${state.finalOutputPath ?? "/workspace/output/final.html"}`);
  }
  function render() {
    updatePhaseDisplay();
    renderVariants();
    updateActionButtons();
  }
  function renderExplorations(explorations) {
    explorationsPanel.classList.toggle("hidden", explorations.length === 0);
    explorationsList.innerHTML = "";
    explorations.forEach((exploration) => {
      const item = document.createElement("div");
      item.className = "exploration-item";
      item.innerHTML = `
      <div>
        <div class="exploration-title">${escapeHtml(exploration.description || "\u672A\u547D\u540D\u63A2\u7D22")}</div>
        <div class="exploration-meta">
          Round ${exploration.round} \xB7 ${phaseLabel(exploration.phase)} \xB7 ${formatDate(exploration.updatedAt)}
        </div>
      </div>
      <button class="btn-secondary" type="button">\u7EE7\u7EED</button>
    `;
      item.querySelector("button")?.addEventListener("click", () => {
        selectExploration(exploration.id).catch(showError);
      });
      explorationsList.appendChild(item);
    });
  }
  function renderClarification(payload) {
    clarificationQuestions.innerHTML = "";
    payload.questions.forEach((question) => {
      const wrapper = document.createElement("div");
      wrapper.className = "clarification-question";
      wrapper.dataset.questionId = question.id;
      wrapper.innerHTML = `
      <label>${escapeHtml(question.label)}${question.required ? " *" : ""}</label>
      <p class="why">${escapeHtml(question.why)}</p>
      ${renderQuestionInput(question)}
    `;
      clarificationQuestions.appendChild(wrapper);
    });
    clarificationPanel.classList.remove("hidden");
    explorationsPanel.classList.add("hidden");
  }
  function renderVariants() {
    variantsGrid.innerHTML = "";
    currentState.variants.forEach((variant, index) => {
      const card = document.createElement("div");
      card.className = "variant-card";
      card.dataset.id = variant.id;
      const rating = currentState.scores[variant.id] ?? 0;
      const iframe = `${variant.path}?v=${variant.round}`;
      card.innerHTML = `
      <div class="variant-preview">
        <iframe title="\u8BBE\u8BA1\u53D8\u4F53 ${index + 1}" src="${iframe}"></iframe>
      </div>
      <div class="variant-info">
        <div class="variant-title">\u53D8\u4F53 ${index + 1}</div>
        <div class="variant-rating" data-rating="${rating}">
          ${renderStars(rating)}
        </div>
      </div>
    `;
      card.addEventListener("click", () => openVariantModal(variant));
      variantsGrid.appendChild(card);
    });
  }
  function renderStars(rating) {
    return Array.from(
      { length: 5 },
      (_, index) => `<span class="star ${index < rating ? "active" : ""}">\u2605</span>`
    ).join("");
  }
  function openVariantModal(variant) {
    currentModalVariant = variant;
    updateStarDisplay(currentState.scores[variant.id] ?? 0);
    previewFrame.removeAttribute("srcdoc");
    previewFrame.src = `${variant.path}?v=${variant.round}`;
    modalOverlay.classList.remove("hidden");
  }
  function closeVariantModal() {
    modalOverlay.classList.add("hidden");
    currentModalVariant = null;
    previewFrame.removeAttribute("src");
  }
  function updateStarDisplay(rating, isHover = false) {
    starRating.querySelectorAll(".star").forEach((star, index) => {
      star.classList.toggle("active", index < rating);
    });
    ratingLabel.textContent = ratingLabels[rating];
    ratingLabel.style.color = isHover ? "#fbbf24" : "#fff";
  }
  function updateVariantCardRating(variantId, rating) {
    const card = document.querySelector(`[data-id="${variantId}"]`);
    const ratingContainer = card?.querySelector(".variant-rating");
    if (ratingContainer) {
      ratingContainer.innerHTML = renderStars(rating);
    }
  }
  function updateActionButtons() {
    const scoredCount = Object.keys(currentState.scores).length;
    nextRoundBtn.disabled = scoredCount === 0 || currentState.phase === "finalized";
    nextRoundBtn.textContent = scoredCount > 0 ? `\u4E0B\u4E00\u8F6E\u63A2\u7D22 (${scoredCount}/${currentState.variants.length} \u5DF2\u8BC4\u5206) \u2192` : "\u8BF7\u5148\u4E3A\u8BBE\u8BA1\u6253\u5206";
    finalizeBtn.classList.toggle("hidden", currentState.phase !== "converge" || scoredCount === 0);
  }
  function updatePhaseDisplay() {
    phaseBadge.textContent = `Phase: ${phaseLabel(currentState.phase)}`;
    roundBadge.textContent = `Round ${currentState.round}`;
    currentRound.textContent = String(currentState.round);
  }
  function applyServerState(state) {
    currentState.id = state.id;
    currentState.round = state.round;
    currentState.phase = state.phase;
    currentState.variants = state.variants;
    currentState.description = state.userDescription;
    currentState.finalOutputPath = state.finalOutputPath;
    currentState.scores = Object.fromEntries(state.scores.map((score) => [score.variantId, score.rating]));
  }
  function pickHighestRatedVariant() {
    const entries = Object.entries(currentState.scores);
    if (entries.length === 0) {
      return null;
    }
    return entries.sort((a, b) => b[1] - a[1])[0][0];
  }
  function showGallery() {
    startScreen.classList.add("hidden");
    galleryScreen.classList.remove("hidden");
  }
  function showStart() {
    closeVariantModal();
    galleryScreen.classList.add("hidden");
    startScreen.classList.remove("hidden");
  }
  function hideClarification() {
    clarificationPanel.classList.add("hidden");
    clarificationQuestions.innerHTML = "";
    currentClarification = null;
    pendingDescription = "";
    loadExplorations().catch(showError);
  }
  function showLoading() {
    loadingOverlay.classList.remove("hidden");
  }
  function hideLoading() {
    loadingOverlay.classList.add("hidden");
  }
  async function requestJson(url, init) {
    const response = await fetch(url, init);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(readErrorMessage(payload) ?? `Request failed with ${response.status}.`);
    }
    return payload;
  }
  function readErrorMessage(payload) {
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = payload.error;
      return typeof error === "string" ? error : null;
    }
    return null;
  }
  function renderQuestionInput(question) {
    if (question.type === "single_select") {
      return `
      <select data-question-input="${escapeHtml(question.id)}">
        <option value="">\u8BF7\u9009\u62E9</option>
        ${(question.options ?? []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}
      </select>
      ${renderOtherInput(question)}
    `;
    }
    if (question.type === "multi_select") {
      return `
      <div class="clarification-options" data-question-input="${escapeHtml(question.id)}">
        ${(question.options ?? []).map((option) => `
          <label class="clarification-option">
            <input type="checkbox" value="${escapeHtml(option)}">
            <span>${escapeHtml(option)}</span>
          </label>
        `).join("")}
      </div>
      ${renderOtherInput(question)}
    `;
    }
    const defaultValue = typeof question.defaultValue === "string" ? question.defaultValue : "";
    return `<input data-question-input="${escapeHtml(question.id)}" type="text" value="${escapeHtml(defaultValue)}" placeholder="\u8BF7\u8F93\u5165">`;
  }
  function renderOtherInput(question) {
    if (!question.allowOther) {
      return "";
    }
    return `<input data-question-other="${escapeHtml(question.id)}" type="text" placeholder="\u5176\u4ED6\u8865\u5145\uFF0C\u53EF\u7559\u7A7A">`;
  }
  function collectClarificationAnswers(payload) {
    const answers = {};
    for (const question of payload.questions) {
      const answer = readQuestionAnswer(question);
      const isEmpty = Array.isArray(answer) ? answer.length === 0 : answer.trim().length === 0;
      if (question.required && isEmpty) {
        alert(`\u8BF7\u56DE\u7B54\uFF1A${question.label}`);
        return null;
      }
      if (!isEmpty) {
        answers[question.id] = answer;
      }
    }
    return answers;
  }
  function readQuestionAnswer(question) {
    const selector = `[data-question-input="${cssEscape(question.id)}"]`;
    const element = clarificationQuestions.querySelector(selector);
    if (!element) {
      return question.type === "multi_select" ? [] : "";
    }
    if (question.type === "multi_select") {
      const values = Array.from(element.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
      const other2 = readOtherAnswer(question.id);
      return other2 ? [...values, `Other: ${other2}`] : values;
    }
    const value = element.value.trim();
    const other = readOtherAnswer(question.id);
    return other ? [value, `Other: ${other}`].filter(Boolean).join(", ") : value;
  }
  function readOtherAnswer(questionId) {
    return clarificationQuestions.querySelector(`[data-question-other="${cssEscape(questionId)}"]`)?.value.trim() ?? "";
  }
  function buildClarifiedDescription(description, payload, answers) {
    const lines = Object.entries(answers).map(([id, value]) => {
      const question = payload.questions.find((item) => item.id === id);
      const label = question?.label ?? id;
      const text = Array.isArray(value) ? value.join(", ") : value;
      return `- ${label}: ${text}`;
    });
    return [
      description,
      "",
      "Clarification answers:",
      ...lines,
      "",
      "Assumptions:",
      ...payload.assumptions.map((assumption) => `- ${assumption}`)
    ].join("\n");
  }
  function cssEscape(value) {
    if (typeof CSS !== "undefined" && CSS.escape) {
      return CSS.escape(value);
    }
    return value.replace(/["\\]/g, "\\$&");
  }
  function phaseLabel(phase) {
    const phaseText = {
      explore: "\u63A2\u7D22",
      converge: "\u5BF9\u6218",
      finalized: "\u5DF2\u5B9A\u7A3F"
    };
    return phaseText[phase];
  }
  function formatDate(timestamp) {
    if (!timestamp) {
      return "\u672A\u77E5\u65F6\u95F4";
    }
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(timestamp));
  }
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => {
      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      };
      return map[char];
    });
  }
  function query(id) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing element: ${id}`);
    }
    return element;
  }
  function showError(error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("Design Explorer error:", error);
    hideLoading();
    alert(message);
  }
})();
