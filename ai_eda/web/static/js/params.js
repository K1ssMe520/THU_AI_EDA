/* ------------------------------ API parameter lab ------------------------------ */

function paramDemo(demoId) {
  return state.params.lab?.demos.find((demo) => demo.id === demoId) || null;
}

function paramCompletionTokens(result) {
  return result?.usage?.completion_tokens ?? null;
}

function formatParamMeta(result) {
  const parts = [];
  const completion = paramCompletionTokens(result);
  if (completion !== null) parts.push(`completion ${completion} tok`);
  parts.push(formatDuration(result?.duration_ms));
  if (result?.finish_reason) parts.push(`finish_reason=${result.finish_reason}`);
  return parts.join(" · ");
}

function numberClose(actual, expected) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return Math.abs(actual - expected) <= Math.max(0.02, Math.abs(expected) * 0.001);
}

function evaluateReasoningAnswer(demo, answer) {
  const expectedValues = (demo.expected_values?.length ? demo.expected_values : [Number(demo.expected_answer)])
    .map(Number)
    .filter((value) => Number.isFinite(value));
  const labels = demo.expected_labels?.length
    ? demo.expected_labels
    : expectedValues.map((_, index) => `第 ${index + 1} 项`);
  const lines = (answer || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const answerLine = [...lines].reverse().find((line) => line.includes("答案"));
  let hits = null;
  let formatted = false;
  if (answerLine) {
    const numbers = (answerLine.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (numbers.length >= expectedValues.length) {
      formatted = true;
      hits = expectedValues.map((value, index) => ({
        label: labels[index],
        expected: value,
        actual: numbers[index],
        hit: numberClose(numbers[index], value),
      }));
    }
  }
  if (!hits) {
    const allNumbers = ((answer || "").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    hits = expectedValues.map((value, index) => ({
      label: labels[index],
      expected: value,
      actual: null,
      hit: allNumbers.some((number) => numberClose(number, value)),
    }));
  }
  const hitCount = hits.filter((item) => item.hit).length;
  return { hits, hitCount, total: expectedValues.length, complete: hitCount === expectedValues.length, formatted };
}

function textSimilarity(left, right) {
  const normalize = (text) => (text || "")
    .replace(/\s+/g, "")
    .replace(/[，。；：、！？,.;:!?"'“”‘’()（）\[\]【】{}<>《》]/g, "");
  const collect = (text) => {
    const grams = new Map();
    for (let index = 0; index < text.length - 1; index += 1) {
      const gram = text.slice(index, index + 2);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }
    return grams;
  };
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  const leftGrams = collect(a);
  const rightGrams = collect(b);
  let overlap = 0;
  let total = 0;
  leftGrams.forEach((count, gram) => {
    overlap += Math.min(count, rightGrams.get(gram) || 0);
    total += count;
  });
  rightGrams.forEach((count) => { total += count; });
  return total ? (2 * overlap) / total : 0;
}

function createParamEmpty(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "param-empty";
  paragraph.textContent = text;
  return paragraph;
}

function createParamResultCard({ label, badge, badgeTone = "neutral", meta, verdict, verdictTone = "", answer, reasoning }) {
  const card = document.createElement("article");
  card.className = "param-result";
  const head = document.createElement("header");
  head.className = "param-result-head";
  const heading = document.createElement("span");
  heading.className = "param-result-label";
  heading.textContent = label;
  head.append(heading);
  if (badge) {
    const tag = document.createElement("span");
    tag.className = `param-badge ${badgeTone}`;
    tag.textContent = badge;
    head.append(tag);
  }
  if (meta) {
    const metaNode = document.createElement("span");
    metaNode.className = "param-result-meta";
    metaNode.textContent = meta;
    head.append(metaNode);
  }
  card.append(head);
  if (verdict) {
    const verdictNode = document.createElement("p");
    verdictNode.className = `param-verdict${verdictTone ? ` ${verdictTone}` : ""}`;
    verdictNode.textContent = verdict;
    card.append(verdictNode);
  }
  const answerNode = document.createElement("div");
  answerNode.className = "param-answer";
  renderRichContent(answerNode, answer || "（模型没有返回可展示的内容）", { format: "auto" });
  card.append(answerNode);
  if (reasoning) {
    const details = document.createElement("details");
    details.className = "param-reasoning";
    const summary = document.createElement("summary");
    summary.textContent = `思维链（${reasoning.length} 字）`;
    const reasoningNode = document.createElement("div");
    renderRichContent(reasoningNode, reasoning, { format: "markdown" });
    details.append(summary, reasoningNode);
    card.append(details);
  }
  return card;
}

function maxTokenVerdict(result) {
  const answer = result?.answer || "";
  if (result?.finish_reason === "length") {
    return {
      badge: "TRUNCATED",
      verdict: `✗ finish_reason=length：回答达到 max_tokens 上限被截断，文本停在 ${answer.length} 字，RTL 不完整。`,
    };
  }
  if (!/\bendmodule\b/.test(answer)) {
    return {
      badge: "INCOMPLETE",
      verdict: "⚠ 回答中没有出现 endmodule，模块仍然不完整。",
    };
  }
  return {
    badge: "COMPLETE",
    verdict: `✓ finish_reason=${result?.finish_reason || "stop"}，回答包含 endmodule，FIFO 模块完整。`,
  };
}

function renderMaxTokenResults(demo, container, results) {
  const grid = document.createElement("div");
  grid.className = "param-result-grid";
  demo.presets.forEach((preset) => {
    const runs = results[preset.key];
    if (!runs?.length) return;
    const result = runs[0];
    const check = maxTokenVerdict(result);
    const complete = check.badge === "COMPLETE";
    grid.append(createParamResultCard({
      label: preset.label,
      badge: check.badge,
      badgeTone: complete ? "pass" : "fail",
      meta: formatParamMeta(result),
      verdict: check.verdict,
      verdictTone: complete ? "pass" : "fail",
      answer: result.answer,
      reasoning: result.reasoning,
    }));
  });
  if (!grid.childElementCount) return;
  container.append(grid);
}

function renderTemperatureResults(demo, container, results) {
  demo.presets.forEach((preset) => {
    const runs = results[preset.key];
    if (!runs?.length) return;
    const block = document.createElement("section");
    block.className = "param-temp-block";
    const head = document.createElement("header");
    head.className = "param-temp-head";
    head.textContent = preset.label;
    block.append(head);
    if (runs.length >= 2) {
      const similarity = Math.round(textSimilarity(runs[0].answer, runs[1].answer) * 100);
      const row = document.createElement("div");
      row.className = "param-similarity-row";
      const chip = document.createElement("span");
      chip.className = "param-badge neutral";
      chip.textContent = similarity >= 80 ? "低温 · 两次回答高度一致" : "高温 · 两次回答差异明显";
      const value = document.createElement("span");
      value.className = "param-similarity-value";
      value.textContent = `相似度 ${similarity}%`;
      const track = document.createElement("div");
      track.className = "param-similarity-track";
      const fill = document.createElement("span");
      fill.className = "param-similarity-fill";
      fill.style.width = `${similarity}%`;
      track.append(fill);
      row.append(chip, value, track);
      block.append(row);
    }
    const grid = document.createElement("div");
    grid.className = "param-result-grid";
    runs.forEach((result, index) => {
      grid.append(createParamResultCard({
        label: `第 ${index + 1} 次生成`,
        badge: `T = ${result.settings?.temperature ?? preset.settings.temperature}`,
        meta: formatParamMeta(result),
        answer: result.answer,
        reasoning: result.reasoning,
      }));
    });
    block.append(grid);
    container.append(block);
  });
}

function renderReasoningResults(demo, container, results) {
  const grid = document.createElement("div");
  grid.className = "param-result-grid";
  demo.presets.forEach((preset) => {
    const runs = results[preset.key];
    if (!runs?.length) return;
    const result = runs[0];
    const check = evaluateReasoningAnswer(demo, result.answer);
    const reasoningChars = (result.reasoning || "").length;
    let badge;
    let tone;
    let verdict;
    if (check.complete && check.formatted) {
      badge = `全部命中 ${check.total}/${check.total}`;
      tone = "pass";
      verdict = `✓ 最终答案行与参考答案的 ${check.total} 项数值全部一致。参考答案：${demo.expected_answer}`;
    } else if (check.complete) {
      badge = "数值全对 · 未按格式";
      tone = "warn";
      verdict = `⚠ 全文数值与 ${check.total} 项参考答案均一致，但未找到以「答案=」结尾的答案行；请人工确认输出格式与最终结论。参考答案：${demo.expected_answer}`;
    } else if (check.hitCount > 0) {
      badge = `命中 ${check.hitCount}/${check.total}`;
      tone = "warn";
      const missed = check.hits
        .filter((item) => !item.hit)
        .map((item) => `${item.label} 期望 ${item.expected.toFixed(2)}、实际 ${item.actual === null ? "未按格式给出" : item.actual.toFixed(2)}`)
        .join("；");
      verdict = `✗ ${check.formatted ? "最终答案行" : "全文数值"}只命中 ${check.hitCount}/${check.total} 项：${missed}。参考答案：${demo.expected_answer}`;
    } else {
      badge = "未命中参考答案";
      tone = "fail";
      verdict = `✗ 最终答案未命中参考答案。参考答案：${demo.expected_answer}`;
    }
    grid.append(createParamResultCard({
      label: preset.label,
      badge,
      badgeTone: tone,
      meta: `${formatParamMeta(result)}${reasoningChars ? ` · 思维链 ${reasoningChars} 字` : " · 未返回思维链"}`,
      verdict,
      verdictTone: tone,
      answer: result.answer,
      reasoning: result.reasoning,
    }));
  });
  if (!grid.childElementCount) return;
  container.append(grid);
}

function renderParamResults(demo) {
  const card = document.querySelector(`[data-param-demo="${demo.id}"]`);
  const container = card?.querySelector("[data-param-results]");
  if (!container) return;
  container.replaceChildren();
  const results = state.params.results[demo.id] || {};
  if (!Object.keys(results).length) {
    container.append(createParamEmpty("尚未运行。点击上方按钮会用这道固定题目真实调用一次模型，并显示回答、思维链与 token 用量。"));
    return;
  }
  if (demo.check === "similarity") renderTemperatureResults(demo, container, results);
  else if (demo.check === "expected_answer") renderReasoningResults(demo, container, results);
  else renderMaxTokenResults(demo, container, results);
}

function createParamDemoCard(demo) {
  const card = document.createElement("article");
  card.className = "panel param-demo";
  card.dataset.paramDemo = demo.id;

  const head = document.createElement("header");
  head.className = "param-demo-head";
  head.innerHTML = `
    <div>
      <p class="eyebrow">EXPERIMENT ${String(demo.index).padStart(2, "0")}</p>
      <h2>${escapeHtml(demo.title)}</h2>
    </div>
    <span class="param-chip">${escapeHtml(demo.parameter)}</span>
  `;
  card.append(head);

  const summary = document.createElement("p");
  summary.className = "param-summary";
  summary.textContent = demo.summary;
  card.append(summary);

  const questionWrap = document.createElement("div");
  questionWrap.className = "param-question-wrap";
  const questionHead = document.createElement("div");
  questionHead.className = "param-question-head";
  questionHead.textContent = "实验题目 · 固定 Prompt";
  const question = document.createElement("pre");
  question.className = "param-question";
  question.textContent = demo.question;
  questionWrap.append(questionHead, question);
  card.append(questionWrap);

  const hint = document.createElement("p");
  hint.className = "param-hint";
  hint.textContent = demo.hint;
  card.append(hint);

  const actions = document.createElement("div");
  actions.className = "param-actions";
  demo.presets.forEach((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "param-run-button";
    button.dataset.paramRun = preset.key;
    button.textContent = preset.label;
    actions.append(button);
  });
  card.append(actions);

  const status = document.createElement("p");
  status.className = "param-run-status hidden";
  status.dataset.paramStatus = "";
  card.append(status);

  const results = document.createElement("div");
  results.className = "param-results";
  results.dataset.paramResults = "";
  card.append(results);
  return card;
}

function renderParamSubTabs() {
  const bar = $("#param-sub-tabs");
  const lab = state.params.lab;
  if (!bar || !lab) return;
  bar.replaceChildren();
  lab.demos.forEach((demo) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sub-tab";
    button.dataset.paramTab = demo.id;
    button.textContent = `${String(demo.index).padStart(2, "0")} · ${String(demo.parameter).replaceAll("_", " ").toUpperCase()}`;
    bar.append(button);
  });
}

function activateParamTab(name) {
  const lab = state.params.lab;
  if (!lab || !lab.demos.length) return;
  const target = lab.demos.some((demo) => demo.id === name) ? name : lab.demos[0].id;
  state.params.activeTab = target;
  $$("[data-param-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.paramTab === target);
  });
  $$("[data-param-page]").forEach((page) => {
    page.classList.toggle("hidden", page.dataset.paramPage !== target);
  });
}

function renderParamLab() {
  const lab = state.params.lab;
  if (!lab) return;
  $("#params-model").textContent = lab.model;
  $("#params-base-url").textContent = lab.base_url;
  const wrap = $("#params-demos");
  wrap.replaceChildren();
  lab.demos.forEach((demo) => {
    const page = document.createElement("section");
    page.className = "param-page";
    page.dataset.paramPage = demo.id;
    page.append(createParamDemoCard(demo));
    wrap.append(page);
  });
  lab.demos.forEach((demo) => renderParamResults(demo));
  renderParamSubTabs();
  activateParamTab(state.params.activeTab);
}

async function loadParamLab() {
  try {
    state.params.lab = await api("/api/param-lab");
    renderParamLab();
  } catch (error) {
    const wrap = $("#params-demos");
    wrap.replaceChildren();
    const message = document.createElement("p");
    message.className = "panel params-loading";
    message.textContent = `无法读取参数实验定义：${error.message}`;
    wrap.append(message);
    showToast(error.message, "error");
  }
}

function setParamStatus(demoId, message, tone = "") {
  const card = document.querySelector(`[data-param-demo="${demoId}"]`);
  const status = card?.querySelector("[data-param-status]");
  if (!status) return;
  status.className = `param-run-status${tone ? ` ${tone}` : ""}${message ? "" : " hidden"}`;
  status.textContent = message;
}

function updateParamButtons(demoId) {
  const card = document.querySelector(`[data-param-demo="${demoId}"]`);
  if (!card) return;
  const running = Boolean(state.params.running[demoId]);
  card.querySelectorAll("[data-param-run]").forEach((button) => { button.disabled = running; });
}

async function runParamExperiment(demoId, presetKey) {
  const demo = paramDemo(demoId);
  const preset = demo?.presets.find((item) => item.key === presetKey);
  if (!demo || !preset || state.params.running[demoId]) return;
  const runCount = preset.runs || 1;
  const startedAt = Date.now();
  let currentRun = 0;
  const statusText = () => {
    const runHint = runCount > 1 && currentRun ? ` · 第 ${currentRun}/${runCount} 次` : "";
    return `正在调用模型${runCount > 1 ? `（连续 ${runCount} 次）` : ""}… ${formatDuration(Date.now() - startedAt)}${runHint}`;
  };
  state.params.running[demoId] = true;
  updateParamButtons(demoId);
  setParamStatus(demoId, statusText());
  const timer = setInterval(() => {
    if (!state.params.running[demoId]) return;
    setParamStatus(demoId, statusText());
  }, 1000);
  try {
    const runs = [];
    for (let index = 0; index < runCount; index += 1) {
      currentRun = index + 1;
      setParamStatus(demoId, statusText());
      runs.push(await api("/api/param-lab/run", {
        method: "POST",
        body: JSON.stringify({ demo_id: demoId, ...preset.settings }),
      }));
    }
    state.params.results[demoId] = { ...(state.params.results[demoId] || {}), [presetKey]: runs };
    renderParamResults(demo);
    setParamStatus(demoId, "");
    showToast(`${demo.parameter} 实验完成：${preset.label}`, "success");
  } catch (error) {
    setParamStatus(demoId, error.message, "error");
    showToast(error.message, "error");
  } finally {
    clearInterval(timer);
    state.params.running[demoId] = false;
    updateParamButtons(demoId);
  }
}

