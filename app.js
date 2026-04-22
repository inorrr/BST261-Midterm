const QUESTIONS_PER_EXAM = 15;

const state = {
  bank: [],
  current: [],
  answers: {},
  submitted: false,
  showingMissedOnly: false
};

const examForm = document.querySelector("#examForm");
const statusEl = document.querySelector("#status");
const progressText = document.querySelector("#progressText");
const scoreText = document.querySelector("#scoreText");
const summaryContent = document.querySelector("#summaryContent");
const newExamBtn = document.querySelector("#newExamBtn");
const submitBtn = document.querySelector("#submitBtn");
const reviewBtn = document.querySelector("#reviewBtn");

newExamBtn.addEventListener("click", startExam);
submitBtn.addEventListener("click", submitExam);
reviewBtn.addEventListener("click", toggleMissedReview);
examForm.addEventListener("change", event => {
  if (event.target.matches("input[type='radio']")) {
    const index = event.target.name.replace("q", "");
    state.answers[index] = event.target.value;
  }
  updateProgress();
});

loadQuestionBank();

async function loadQuestionBank() {
  setControls(false);
  try {
    state.bank = await fetchQuestionBank();
    statusEl.textContent = `Loaded ${state.bank.length} questions.`;
    setControls(true);
    await startExam();
  } catch (error) {
    statusEl.textContent = "Could not load the question bank. Run python3 server.py from this folder and refresh.";
    summaryContent.textContent = error.message;
  }
}

async function fetchQuestionBank() {
  const response = await fetch("mock_exam_questions.csv", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  return parseCsv(text).map(normalizeQuestion);
}

function normalizeQuestion(row) {
  return {
    id: row.id,
    question: row.question,
    choices: parseChoices(row["choice(c)"]),
    answer: row["correct answer"].trim(),
    concept: row["which concept this question belongs to"].trim(),
    timesAppeared: Number(row.times_appeared || 0),
    timesCorrect: Number(row.times_correct || 0)
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some(value => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [headers, ...records] = rows;
  return records.map(record => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function parseChoices(choiceText) {
  return choiceText.split(" | ").map(choice => {
    const match = choice.match(/^([A-D])\.\s*(.*)$/);
    return {
      key: match ? match[1] : choice.slice(0, 1),
      text: match ? match[2] : choice
    };
  });
}

async function startExam() {
  setControls(false);
  statusEl.textContent = "Choosing weighted questions...";
  state.current = await getWeightedExam();
  state.answers = {};
  state.submitted = false;
  state.showingMissedOnly = false;
  scoreText.textContent = "Not scored";
  summaryContent.textContent = "Answer all 15 questions, then submit to get a score and concept-level study targets.";
  reviewBtn.textContent = "Review Missed";
  renderExam();
  updateProgress();
  setControls(true);
}

async function getWeightedExam() {
  try {
    const response = await fetch("/api/start-exam", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.bank = await fetchQuestionBank();
    return payload.questions.map(normalizeQuestion);
  } catch (error) {
    statusEl.textContent = "Using browser-only weighted selection. CSV tracking requires python3 server.py.";
    return chooseWeightedLocally(state.bank, QUESTIONS_PER_EXAM);
  }
}

function renderExam() {
  examForm.innerHTML = "";
  state.current.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "question-card";
    card.dataset.index = String(index);

    const selected = getSelected(index);
    const isCorrect = selected === item.answer;

    if (state.submitted) {
      card.classList.add(isCorrect ? "correct" : "missed");
      if (state.showingMissedOnly && isCorrect) card.hidden = true;
    }

    card.innerHTML = `
      <div class="question-meta">
        <span>Question ${index + 1}</span>
        <span class="concept">${escapeHtml(item.concept)}</span>
      </div>
      <p class="question-text">${escapeHtml(item.question)}</p>
      <div class="choices">
        ${item.choices.map(choice => renderChoice(choice, index, selected, item.answer)).join("")}
      </div>
      ${state.submitted ? renderFeedback(selected, item.answer) : ""}
    `;
    examForm.appendChild(card);
  });
}

function renderChoice(choice, index, selected, correctAnswer) {
  const checked = selected === choice.key ? "checked" : "";
  const disabled = state.submitted ? "disabled" : "";
  let className = "choice";

  if (state.submitted && choice.key === correctAnswer) className += " correct-choice";
  if (state.submitted && selected === choice.key && selected !== correctAnswer) className += " wrong-choice";

  return `
    <label class="${className}">
      <input type="radio" name="q${index}" value="${choice.key}" ${checked} ${disabled}>
      <span><strong>${choice.key}.</strong> ${escapeHtml(choice.text)}</span>
    </label>
  `;
}

function renderFeedback(selected, correctAnswer) {
  if (!selected) return `<div class="feedback">No answer selected. Correct answer: ${correctAnswer}.</div>`;
  if (selected === correctAnswer) return `<div class="feedback">Correct.</div>`;
  return `<div class="feedback">Your answer: ${selected}. Correct answer: ${correctAnswer}.</div>`;
}

async function submitExam() {
  if (!state.current.length) return;
  state.submitted = true;
  state.showingMissedOnly = false;
  const result = scoreExam();
  await saveResults();
  scoreText.textContent = `${result.correct} / ${QUESTIONS_PER_EXAM}`;
  statusEl.textContent = `Score: ${result.percent}%.`;
  renderSummary(result);
  renderExam();
}

async function saveResults() {
  const answers = {};
  state.current.forEach((item, index) => {
    answers[item.id] = getSelected(index);
  });

  try {
    const response = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.bank = await fetchQuestionBank();
  } catch (error) {
    statusEl.textContent = "Score calculated, but CSV tracking was not saved. Run python3 server.py for persistence.";
  }
}

function scoreExam() {
  let correct = 0;
  const byConcept = new Map();

  state.current.forEach((item, index) => {
    const selected = getSelected(index);
    const concept = byConcept.get(item.concept) ?? { total: 0, missed: 0 };
    concept.total += 1;
    if (selected === item.answer) {
      correct += 1;
    } else {
      concept.missed += 1;
    }
    byConcept.set(item.concept, concept);
  });

  return {
    correct,
    percent: Math.round((correct / QUESTIONS_PER_EXAM) * 100),
    concepts: [...byConcept.entries()]
      .map(([concept, data]) => ({ concept, ...data }))
      .filter(item => item.missed > 0)
      .sort((a, b) => b.missed / b.total - a.missed / a.total)
  };
}

function renderSummary(result) {
  if (!result.concepts.length) {
    summaryContent.innerHTML = `
      <div class="summary-score">${result.percent}%</div>
      <p>Clean run. For maintenance, review loss curves, CNN layer roles, and VAE latent-space regularity.</p>
    `;
    return;
  }

  summaryContent.innerHTML = `
    <div class="summary-score">${result.percent}%</div>
    <p>Prioritize the concepts where you missed questions:</p>
    ${result.concepts.map(item => {
      const ratio = Math.round((item.missed / item.total) * 100);
      return `
        <div class="concept-row">
          <strong><span>${escapeHtml(item.concept)}</span><span>${item.missed}/${item.total} missed</span></strong>
          <div class="bar" aria-hidden="true"><span style="width: ${ratio}%"></span></div>
        </div>
      `;
    }).join("")}
  `;
}

function toggleMissedReview() {
  if (!state.submitted) {
    statusEl.textContent = "Submit the exam first, then review missed questions.";
    return;
  }
  state.showingMissedOnly = !state.showingMissedOnly;
  reviewBtn.textContent = state.showingMissedOnly ? "Show All" : "Review Missed";
  renderExam();
}

function updateProgress() {
  const answered = state.current.reduce((count, _, index) => count + (getSelected(index) ? 1 : 0), 0);
  progressText.textContent = `${answered} / ${QUESTIONS_PER_EXAM}`;
  if (!state.submitted) {
    statusEl.textContent = answered === QUESTIONS_PER_EXAM
      ? "All questions answered. Ready to submit."
      : `${QUESTIONS_PER_EXAM - answered} question${QUESTIONS_PER_EXAM - answered === 1 ? "" : "s"} left.`;
  }
}

function getSelected(index) {
  return state.answers[index] ?? "";
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function chooseWeightedLocally(rows, count) {
  const pool = [...rows];
  const selected = [];
  for (let i = 0; i < Math.min(count, pool.length); i += 1) {
    const weights = pool.map(questionWeight);
    const chosenIndex = weightedIndex(weights);
    selected.push(pool[chosenIndex]);
    pool.splice(chosenIndex, 1);
  }
  return selected;
}

function questionWeight(item) {
  const appeared = item.timesAppeared || 0;
  const correct = item.timesCorrect || 0;
  const accuracy = appeared ? correct / appeared : 0;
  const exposureBonus = 4 / (1 + appeared);
  const weaknessBonus = appeared === 0 ? 1.2 : 1 + (1 - accuracy) * 2.5;
  return exposureBonus * weaknessBonus;
}

function weightedIndex(weights) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  let pick = Math.random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    pick -= weights[i];
    if (pick <= 0) return i;
  }
  return weights.length - 1;
}

function setControls(enabled) {
  newExamBtn.disabled = !enabled;
  submitBtn.disabled = !enabled;
  reviewBtn.disabled = !enabled;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
