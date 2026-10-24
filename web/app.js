const state = {
  task: null,
  prompts: new Map(),
  activePromptId: null,
  activeMainTab: "params",
  activePromptTab: "teaching",
  activeResponseTab: "combined",
  lastRun: null,
  saveTimer: null,
  streaming: {
    active: false,
    target: null,
    reasoning: "",
    answer: "",
    frame: null,
    reasoningNode: null,
    answerNode: null,
  },
  verifyingTeaching: false,
  verifyingHomework: false,
  homework: {
    task: null,
    prompt: "",
    runs: [],
    lastRun: null,
    activeResponseTab: "combined",
    saveTimer: null,
  },
  params: {
    lab: null,
    results: {},
    running: {},
    activeTab: "max_tokens",
  },
  agent: {
    graph: null,
    serverGraph: null,
    spec: "",
    catalog: { builtin: [], skills: [] },
    skills: [],
    result: null,
    designs: [],
    runs: [],
    designId: null,
    designName: null,
    designBaseline: null,
    selectedNodeId: null,
    saveTimer: null,
    detailTab: "response",
    run: null,
    job: null,
    events: [],
    running: false,
    cancelling: false,
    pollTimer: null,
    runTimer: null,
    runStartedAt: null,
    selectedStep: null,
    followLive: true,
    view: { x: 48, y: 48, scale: 1 },
    needsFit: true,
    history: { past: [], future: [], editSnapshot: null },
    skillEditing: null,
    waitingInput: null,
  },
};

const NODE_W = 232;
const NODE_H = 112;
const FIXED_NODE_W = 200;
const FIXED_NODE_H = 84;
const GRID = 8;
const MIN_SCALE = 0.3;
const MAX_SCALE = 1.8;
const HISTORY_LIMIT = 60;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function showToast(message, type = "info") {
  const stack = $("#toast-stack");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  stack.append(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 220);
  }, 4200);
}

function confirmAction(title, message, confirmLabel = "确认") {
  const dialog = $("#confirm-dialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-accept").textContent = confirmLabel;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "—";
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function formatClock(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return date.toLocaleString("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatTokens(usage) {
  if (!usage || usage.total_tokens === null || usage.total_tokens === undefined) return "";
  return `${usage.total_tokens} tok`;
}

function totalTokens(events) {
  return (events || []).reduce((total, event) => total + Number(event.usage?.total_tokens || 0), 0);
}

function statusMeta(status) {
  return {
    running: ["RUNNING", "running"],
    cancelling: ["STOPPING", "running"],
    passed: ["PASS", "pass"],
    failed: ["FAIL", "fail"],
    completed: ["DONE", "neutral"],
    cancelled: ["STOPPED", "neutral"],
    queued: ["QUEUED", "neutral"],
    waiting_input: ["WAIT", "warn"],
    info: ["DONE", "neutral"],
  }[status] || [String(status || "—").toUpperCase(), "neutral"];
}

/* ------------------------------ Prompt tab ------------------------------ */

function setSaveStatus(text, mode = "") {
  const node = $("#save-status");
  if (!node) return;
  node.textContent = text;
  node.className = `save-status ${mode}`;
}

function activePrompt() { return state.prompts.get(state.activePromptId); }

function buildStageList() {
  const list = $("#prompt-list");
  list.replaceChildren();
  [...state.prompts.entries()].forEach(([id, prompt], index) => {
    const button = document.createElement("button");
    button.className = `stage ${id === state.activePromptId ? "active" : ""}`;
    button.innerHTML = `<span class="stage-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${escapeHtml(prompt.title)}</strong><small>${escapeHtml(prompt.description)}</small></span>`;
    button.addEventListener("click", () => selectPrompt(id));
    list.append(button);
  });
  $("#stage-count").textContent = `${state.prompts.size} stages`;
}

function selectPrompt(id) {
  const prompt = state.prompts.get(id);
  if (!prompt) return;
  state.activePromptId = id;
  $("#prompt-editor").value = prompt.content;
  $("#prompt-description").textContent = prompt.description;
  $("#prompt-file").textContent = prompt.file;
  buildStageList();
}

function responseBlock(label, tone, text, fallback) {
  const block = document.createElement("section");
  block.className = `response-block response-${tone}`;
  const heading = document.createElement("p");
  heading.className = "response-block-label";
  heading.textContent = label;
  const body = document.createElement("pre");
  body.className = "response-block-body";
  if (text) {
    body.textContent = text;
  } else {
    body.classList.add("response-block-note");
    body.textContent = fallback;
  }
  block.append(heading, body);
  return block;
}

function renderResponse() {
  const content = $("#response-content");
  content.replaceChildren();
  $$("[data-response-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.responseTab === state.activeResponseTab);
  });
  if (!state.lastRun) {
    content.className = "response-content empty-copy";
    content.textContent = "运行后将在这里合并显示服务端返回的思维链与最终回答；若模型未返回可展示的 reasoning_content，会明确提示。";
    return;
  }
  content.className = "response-content";
  if (state.activeResponseTab === "rtl") {
    const body = document.createElement("pre");
    body.className = "response-block-body response-rtl";
    body.textContent = state.lastRun.rtl || "未能从模型回答中提取 RTL。";
    content.append(body);
    return;
  }
  content.append(
    responseBlock(
      "思维链",
      "reasoning",
      state.lastRun.reasoning,
      "该次调用未返回可展示的推理文本。可启用“请求模型思考文本”后重新运行；最终 RTL 是否正确仍以 TB 为准。",
    ),
    responseBlock("最终回答", "answer", state.lastRun.answer, "模型未返回最终回答。"),
  );
  content.scrollTop = 0;
}

/* ----------------------------- Streaming model output ----------------------------- */

function streamContentElement(target) {
  return target === "homework" ? $("#hw-response-content") : $("#response-content");
}

function setStreamingActiveTab(target) {
  if (target === "homework") {
    state.homework.activeResponseTab = "combined";
    $$("[data-hw-response-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.hwResponseTab === "combined");
    });
  } else {
    state.activeResponseTab = "combined";
    $$("[data-response-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.responseTab === "combined");
    });
  }
}

function createStreamBlock(label, tone) {
  const block = document.createElement("section");
  block.className = `response-block response-${tone}`;
  const heading = document.createElement("p");
  heading.className = "response-block-label";
  heading.textContent = label;
  const body = document.createElement("pre");
  body.className = "response-block-body response-block-note";
  block.append(heading, body);
  return { block, body };
}

function beginStreamDisplay(target) {
  if (state.streaming.frame) cancelAnimationFrame(state.streaming.frame);
  state.streaming = {
    active: true,
    target,
    reasoning: "",
    answer: "",
    frame: null,
    reasoningNode: null,
    answerNode: null,
  };
  setStreamingActiveTab(target);
  const content = streamContentElement(target);
  if (!content) return;
  content.className = "response-content";
  content.replaceChildren();
  const reasoning = createStreamBlock("思维链", "reasoning");
  const answer = createStreamBlock("最终回答", "answer");
  reasoning.body.textContent = "等待思维链输出…";
  answer.body.textContent = "等待最终回答输出…";
  content.append(reasoning.block, answer.block);
  state.streaming.reasoningNode = reasoning.body;
  state.streaming.answerNode = answer.body;
}

function appendStreamDelta(kind, text) {
  if (!state.streaming.active || !text) return;
  if (kind === "reasoning") state.streaming.reasoning += text;
  else state.streaming.answer += text;
  if (state.streaming.frame) return;
  state.streaming.frame = requestAnimationFrame(flushStreamDisplay);
}

function flushStreamDisplay() {
  state.streaming.frame = null;
  if (!state.streaming.active) return;
  const update = (node, text) => {
    if (!node) return;
    node.classList.remove("response-block-note");
    node.textContent = text;
  };
  update(state.streaming.reasoningNode, state.streaming.reasoning);
  update(state.streaming.answerNode, state.streaming.answer);
  const content = streamContentElement(state.streaming.target);
  if (content) content.scrollTop = content.scrollHeight;
}

function endStreamDisplay() {
  if (state.streaming.frame) cancelAnimationFrame(state.streaming.frame);
  state.streaming.frame = null;
  state.streaming.active = false;
}

async function streamApi(path, body, onEvent) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      raw.split("\n").forEach((line) => {
        if (!line.startsWith("data:")) return;
        const payload = JSON.parse(line.slice(5).trim());
        onEvent(payload);
      });
      separator = buffer.indexOf("\n\n");
    }
  }
}

function markTeachingRunPending() {
  const badge = $("#tb-badge");
  badge.textContent = "待验收";
  badge.className = "result-badge neutral";
  $("#tb-summary").textContent = "RTL 已生成，尚未运行教师 TB。点击 TB 面板的「运行 TB」开始验收；面积/功耗可点 metric 面板的「评估 metric」。";
  $("#tb-stdout").textContent = "—";
  const trace = $("#trace-wrap");
  trace.className = "trace-wrap empty-copy";
  trace.textContent = "等待运行教师 TB 后显示 trace。";
  $("#metric-area").textContent = "—";
  $("#metric-unit").textContent = "等待验收";
  $("#metric-power").textContent = "—";
  $("#metric-status").textContent = "PENDING";
  $("#metric-note").textContent = "Yosys / OpenSTA";
}

function markHomeworkRunPending() {
  const badge = $("#hw-tb-badge");
  badge.textContent = "待验收";
  badge.className = "result-badge neutral";
  $("#hw-tb-summary").textContent = "RTL 已生成，尚未运行教师 AES TB。点击 TB 面板的「运行 TB」开始验收；面积/功耗可点 metric 面板的「评估 metric」。";
  $("#hw-tb-stdout").textContent = "—";
  const trace = $("#hw-trace-wrap");
  trace.className = "trace-wrap empty-copy";
  trace.textContent = "等待运行教师 TB 后显示 trace。";
  $("#hw-metric-area").textContent = "—";
  $("#hw-metric-unit").textContent = "等待验收";
  $("#hw-metric-power").textContent = "—";
  $("#hw-metric-status").textContent = "PENDING";
  $("#hw-metric-note").textContent = "Yosys / OpenSTA";
}

function updateTeachingActions() {
  const busy = state.streaming.active || state.verifyingTeaching;
  const runButton = $("#run-button");
  if (runButton) runButton.disabled = busy;
  const hasRun = Boolean(state.lastRun?.run_id);
  ["#run-tb-button", "#run-metric-button"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = busy || !hasRun;
  });
}

function updateHomeworkActions() {
  const busy = state.streaming.active || state.verifyingHomework;
  const runButton = $("#hw-run-button");
  if (runButton) runButton.disabled = busy;
  const hasRun = Boolean(state.homework.lastRun?.run_id);
  ["#hw-run-tb-button", "#hw-run-metric-button"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = busy || !hasRun;
  });
}

function signal(value, expected) {
  const mismatch = expected !== undefined && expected !== "" && value !== expected;
  const className = mismatch ? "signal-mismatch" : value === "1" ? "signal-high" : "signal-low";
  return `<span class="${className}">${escapeHtml(value ?? "—")}</span>`;
}

function renderTrace(trace = []) {
  const wrap = $("#trace-wrap");
  if (!trace.length) {
    wrap.className = "trace-wrap empty-copy";
    wrap.textContent = "该次运行未产生可视化 trace；编译失败时请查看原始 TB 输出。";
    return;
  }
  const template = $("#trace-template");
  const table = template.content.firstElementChild.cloneNode(true);
  const body = table.querySelector("tbody");
  trace.forEach((event) => {
    const row = document.createElement("tr");
    const input = `${signal(event.in_valid)} · ${signal(event.in_ready)} · ${signal(event.in_bit)}`;
    const output = `${signal(event.out_valid, event.expected_valid)} · ${signal(event.out_ready)} · ${signal(event.match, event.expected_match)}`;
    const expected = `${signal(event.expected_valid)} · ${signal(event.expected_match)}`;
    row.innerHTML = `<td>${escapeHtml(event.cycle)}</td><td>${escapeHtml(event.case || "—")}<br><small>${escapeHtml(event.event || "sample")}</small></td><td>${input}</td><td>${output}</td><td>${expected}</td>`;
    body.append(row);
  });
  wrap.className = "trace-wrap";
  wrap.replaceChildren(table);
}

function renderReport(report = {}) {
  const badge = $("#tb-badge");
  const passed = report.passed;
  badge.textContent = passed === true ? "PASS" : passed === false ? "FAIL" : "NO RUN";
  badge.className = `result-badge ${passed === true ? "pass" : passed === false ? "fail" : "neutral"}`;
  const checks = report.checks || [];
  const checkText = checks.length ? ` · ${checks.map((item) => item.name).join("、")}` : "";
  $("#tb-summary").textContent = report.stage
    ? `${report.stage === "compile" ? "编译" : "仿真"}${passed ? "通过" : "失败"}${checkText}`
    : "尚无测试结果。";
  $("#tb-stdout").textContent = [report.stdout, report.stderr].filter(Boolean).join("\n") || "—";
  renderTrace(report.trace || []);
  const metrics = report.metrics || {};
  if (metrics.area !== undefined) {
    $("#metric-area").textContent = Number(metrics.area).toFixed(3);
    $("#metric-unit").textContent = metrics.area_unit || "library area units";
    if (metrics.power_status === "ok") {
      $("#metric-power").textContent = `${(Number(metrics.total_power_w) * 1e6).toFixed(3)} µW`;
      $("#metric-status").textContent = "POWER READY";
      $("#metric-note").textContent = `动态 ${(Number(metrics.dynamic_power_w) * 1e6).toFixed(3)} µW · 漏电 ${(Number(metrics.leakage_power_w) * 1e6).toFixed(3)} µW`;
    } else {
      $("#metric-power").textContent = "—";
      $("#metric-status").textContent = "AREA ONLY";
      $("#metric-note").textContent = metrics.power_reason || "OpenSTA";
    }
  } else {
    $("#metric-area").textContent = "—";
    $("#metric-unit").textContent = metrics.reason || "仅在仿真后的综合成功时显示";
    $("#metric-power").textContent = "N/A";
    $("#metric-status").textContent = metrics.status ? metrics.status.toUpperCase() : "WAIT";
    $("#metric-note").textContent = "Yosys / OpenSTA";
  }
}

function renderRun(run) {
  state.lastRun = run;
  const report = run.report || {};
  $("#run-id-label").textContent = run.run_id;
  renderResponse();
  renderReport(report);
  if (!report.stage) {
    if (report.metrics) {
      const badge = $("#tb-badge");
      badge.textContent = "NO RUN";
      badge.className = "result-badge neutral";
      $("#tb-summary").textContent = "面积/功耗 metric 已评估；教师 TB 尚未运行。点击「运行 TB」开始验收。";
      $("#tb-stdout").textContent = "—";
      const trace = $("#trace-wrap");
      trace.className = "trace-wrap empty-copy";
      trace.textContent = "尚未运行教师 TB。";
      $("#run-status").textContent = `metric 已评估，待运行 TB：${run.run_id}`;
    } else {
      markTeachingRunPending();
      $("#run-status").textContent = `已生成，待验收：${run.run_id}`;
    }
  } else {
    $("#run-status").textContent = `完成：${run.run_id}`;
  }
  $("#run-status").className = "run-status";
  updateTeachingActions();
}

async function generatePrompt() {
  const button = $("#run-button");
  const prompt = activePrompt();
  if (!prompt || state.streaming.active) return;
  button.disabled = true;
  updateTeachingActions();
  $("#run-status").textContent = "正在请求模型，输出会实时显示…";
  $("#run-status").className = "run-status running";
  $("#run-id-label").textContent = "生成中…";
  beginStreamDisplay("teaching");
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!state.streaming.active) return;
    $("#run-status").textContent = `正在生成… ${formatDuration(Date.now() - startedAt)}`;
  }, 500);
  let generated = null;
  try {
    await streamApi("/api/runs/stream", {
      prompt_id: prompt.id,
      content: $("#prompt-editor").value,
      temperature: Number($("#temperature").value),
      max_tokens: Number($("#max-tokens").value),
      thinking: $("#thinking").checked,
      reasoning_effort: $("#reasoning-effort").value,
    }, (event) => {
      if (event.type === "start") {
        $("#run-id-label").textContent = event.run_id;
      } else if (event.type === "reasoning") {
        appendStreamDelta("reasoning", event.text);
      } else if (event.type === "answer") {
        appendStreamDelta("answer", event.text);
      } else if (event.type === "done") {
        generated = event.run;
      } else if (event.type === "error") {
        throw new Error(event.error);
      }
    });
    endStreamDisplay();
    if (!generated) throw new Error("流式生成没有返回运行记录。");
    renderRun(generated);
    $("#run-status").textContent = "生成完成。确认 RTL 后，可点击 TB 面板的「运行 TB」或 metric 面板的「评估 metric」。";
    await loadRuns();
  } catch (error) {
    endStreamDisplay();
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
    if (state.lastRun) renderResponse();
    else {
      const content = $("#response-content");
      content.className = "response-content empty-copy";
      content.textContent = "生成失败；修正参数后重试。";
      $("#run-id-label").textContent = "尚未运行";
    }
  } finally {
    clearInterval(timer);
    button.disabled = false;
    updateTeachingActions();
  }
}

async function verifyPromptMode(mode) {
  if (!state.lastRun?.run_id) {
    showToast("请先生成或载入一条运行记录", "warning");
    return;
  }
  if (state.verifyingTeaching) return;
  state.verifyingTeaching = true;
  updateTeachingActions();
  const label = mode === "tb" ? "教师 TB" : "面积/功耗 metric";
  $("#run-status").textContent = `正在运行${label}…`;
  $("#run-status").className = "run-status running";
  const startedAt = Date.now();
  const timer = setInterval(() => {
    $("#run-status").textContent = `正在运行${label}… ${formatDuration(Date.now() - startedAt)}`;
  }, 500);
  try {
    const run = await api("/api/verify", {
      method: "POST",
      body: JSON.stringify({ task_id: state.task.id, run_id: state.lastRun.run_id, mode }),
    });
    renderRun(run);
    await loadRuns();
    showToast(`${label}已更新`, "success");
  } catch (error) {
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
    showToast(error.message, "error");
  } finally {
    clearInterval(timer);
    state.verifyingTeaching = false;
    updateTeachingActions();
  }
}

async function runPromptTB() {
  await verifyPromptMode("tb");
}

async function runPromptMetric() {
  await verifyPromptMode("metrics");
}

async function loadRun(runId) {
  if (state.streaming.active) {
    showToast("模型正在输出，请等待生成完成后再切换运行记录", "warning");
    return;
  }
  try { renderRun(await api(`/api/runs/${state.task.id}/${runId}`)); }
  catch (error) {
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
  }
}

async function loadRuns() {
  if (!state.task) return;
  const payload = await api(`/api/tasks/${state.task.id}/runs`);
  const list = $("#run-list");
  list.replaceChildren();
  if (!payload.runs.length) {
    list.className = "run-list empty-copy";
    list.textContent = "尚无本任务运行记录";
    return;
  }
  list.className = "run-list";
  payload.runs.slice().reverse().slice(0, 8).forEach((run) => {
    const item = document.createElement("div");
    item.className = "run-item";
    const open = document.createElement("button");
    open.className = "run-open-button";
    open.innerHTML = `${escapeHtml(run.run_id)}<span>${run.passed === true ? "PASS" : run.passed === false ? "FAIL" : "未验收"} · ${escapeHtml(run.prompt_source || "")}</span>`;
    open.addEventListener("click", () => loadRun(run.run_id));
    const remove = document.createElement("button");
    remove.className = "run-delete-button";
    remove.type = "button";
    remove.title = `删除 ${run.run_id}`;
    remove.setAttribute("aria-label", `删除运行记录 ${run.run_id}`);
    remove.textContent = "删除";
    remove.addEventListener("click", () => deleteRun(run.run_id));
    item.append(open, remove);
    list.append(item);
  });
  updateTeachingActions();
}

async function deleteRun(runId) {
  const approved = await confirmAction("删除运行记录", `删除“${runId}”？此操作不可恢复。`, "删除");
  if (!approved) return;
  try {
    await api(`/api/runs/${state.task.id}/${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (state.lastRun?.run_id === runId) state.lastRun = null;
    await loadRuns();
    $("#run-status").textContent = `已删除：${runId}`;
    $("#run-status").className = "run-status";
    showToast(`已删除 ${runId}`, "success");
  } catch (error) {
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
  }
}

async function clearRuns() {
  const approved = await confirmAction("清空运行记录", "清空本任务的全部运行记录？此操作不可恢复。", "清空");
  if (!approved) return;
  try {
    await api(`/api/runs/${state.task.id}`, { method: "DELETE" });
    state.lastRun = null;
    renderResponse();
    renderReport({});
    $("#run-id-label").textContent = "尚未运行";
    await loadRuns();
    $("#run-status").textContent = "已清空全部运行记录。";
    $("#run-status").className = "run-status";
    showToast("已清空 Prompt 运行记录", "success");
  } catch (error) {
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
  }
}

/* --------------------------- Agent graph helpers --------------------------- */

const NODE_DEFAULTS = {
  model: {
    title: "New Model Step",
    prompt: "根据以下冻结规格生成可编译的 SystemVerilog RTL。最终输出只能包含一个 RTL 模块，不要输出 Markdown、解释、testbench 或其他模块。\n\n{spec}\n\n如果提供了上一轮验证反馈，请先修复其中的问题：\n{verify_feedback}",
    tools: [],
  },
  verify: {
    title: "New Verify Step",
    prompt: "使用固定教师 TB 验证当前生成 RTL。",
  },
};

const NODE_GLYPHS = {
  model: ["✦", "model-glyph"],
  verify: ["✓", "verify-glyph"],
};

const DEFAULT_AGENT_GRAPH = {
  name: "简易 EDA 自动设计 Agent",
  entry: "designer",
  nodes: [
    {
      id: "designer",
      type: "model",
      title: "01 · RTL Designer",
      prompt: "根据以下冻结规格生成可编译的 SystemVerilog RTL。规格中的接口、时序和复位要求均为强制要求。最终输出只能包含一个 RTL 模块，不要输出 Markdown、解释、testbench 或其他模块。\n\n{spec}\n\n当前为第 {attempt} 轮生成。如果提供了失败反馈，请逐条定位并修复：\n{verify_feedback}",
      tools: ["run_testbench", "synthesize_area", "estimate_power"],
      x: 120,
      y: 120,
    },
    {
      id: "verify",
      type: "verify",
      title: "02 · Compile & TB",
      prompt: "使用教师 testbench 编译并仿真当前生成的 RTL，记录通过状态、检查输出和 metric。",
      x: 540,
      y: 120,
      retry: { target: "designer", max: 2 },
    },
  ],
  edges: [{ from: "designer", to: "verify" }],
};

function normalizeAgentGraph(graph) {
  if (!graph || typeof graph !== "object") return graph;
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(rawNodes.filter((node) => node && typeof node.id === "string").map((node) => [node.id, node]));
  if (!byId.size) return graph;
  const next = new Map();
  rawEdges.forEach((edge) => {
    if (edge && byId.has(edge.from) && byId.has(edge.to)) next.set(edge.from, edge.to);
  });
  const order = [];
  const seen = new Set();
  let current = byId.has(graph.entry) ? graph.entry : rawNodes[0]?.id;
  while (current && !seen.has(current)) {
    seen.add(current);
    order.push(current);
    current = next.get(current);
  }
  rawNodes.forEach((node) => {
    if (node?.id && !seen.has(node.id)) {
      seen.add(node.id);
      order.push(node.id);
    }
  });
  const kept = order.filter((id) => ["model", "verify"].includes(byId.get(id)?.type));
  if (!kept.length) kept.push("designer");
  const nodes = kept.map((id) => {
    const node = JSON.parse(JSON.stringify(byId.get(id) || {
      id: "designer",
      type: "model",
      title: "01 · RTL Designer",
      prompt: NODE_DEFAULTS.model.prompt,
      x: 120,
      y: 120,
    }));
    delete node.retry;
    if (node.type === "model") {
      node.tools = Array.isArray(node.tools) ? node.tools.filter((name) => typeof name === "string") : [];
    }
    return node;
  });
  rawNodes.forEach((raw) => {
    if (!raw || !kept.includes(raw.id) || !raw.retry || !kept.includes(raw.retry.target)) return;
    if (byId.get(raw.retry.target)?.type !== "model") return;
    const node = nodes.find((candidate) => candidate.id === raw.id);
    if (node) node.retry = { target: raw.retry.target, max: Math.max(1, Math.min(5, Number(raw.retry.max) || 2)) };
  });
  return {
    name: graph.name || "Agent 设计流程",
    entry: nodes[0].id,
    nodes,
    edges: nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id })),
  };
}

function agentGraph() { return state.agent.graph; }
function agentNode(id) { return agentGraph()?.nodes.find((node) => node.id === id); }
function agentNext(id) { return agentGraph()?.edges.find((edge) => edge.from === id)?.to || ""; }

function agentChainOrder() {
  const graph = agentGraph();
  if (!graph) return [];
  const order = [];
  const seen = new Set();
  let current = graph.entry;
  while (current && !seen.has(current)) {
    seen.add(current);
    order.push(current);
    current = agentNext(current);
  }
  return order;
}

function graphSnapshot() {
  return agentGraph() ? JSON.stringify(agentGraph()) : "";
}

function designFingerprint(graph) {
  if (!graph) return "";
  return JSON.stringify({
    name: graph.name,
    entry: graph.entry,
    nodes: (graph.nodes || []).map(({ x, y, ...rest }) => rest),
    edges: graph.edges || [],
  });
}

function isDesignDirty() {
  return Boolean(
    state.agent.designName
    && state.agent.designBaseline
    && designFingerprint(agentGraph()) !== state.agent.designBaseline
  );
}

function updateDesignBadge() {
  const badge = $("#agent-design-badge");
  if (!badge) return;
  if (!state.agent.designName) {
    badge.classList.add("hidden");
    badge.textContent = "";
    return;
  }
  const dirty = isDesignDirty();
  badge.classList.remove("hidden");
  badge.classList.toggle("dirty", dirty);
  badge.textContent = `${state.agent.designName}${dirty ? " · 已修改" : ""}`;
  badge.title = dirty ? "当前图与保存的设计不一致；运行会标记为已修改" : "运行将关联到该设计";
}

function setCurrentDesign(design) {
  state.agent.designId = design?.id || null;
  state.agent.designName = design?.name || null;
  state.agent.designBaseline = design
    ? designFingerprint(design.graph || agentGraph())
    : null;
  updateDesignBadge();
}

function currentRunDesign() {
  if (!state.agent.designName) return { design_id: null, design_name: null };
  const dirty = isDesignDirty();
  return {
    design_id: dirty ? null : state.agent.designId,
    design_name: dirty ? `${state.agent.designName}（已修改）` : state.agent.designName,
  };
}

function setAgentSaveStatus(text, mode = "") {
  const node = $("#agent-save-status");
  if (!node) return;
  node.textContent = text;
  node.className = `save-status ${mode}`;
}

function updateUndoRedoButtons() {
  $("#agent-undo").disabled = state.agent.history.past.length === 0;
  $("#agent-redo").disabled = state.agent.history.future.length === 0;
}

function pushHistorySnapshot(snapshot) {
  if (!snapshot || snapshot === graphSnapshot()) return;
  state.agent.history.past.push(snapshot);
  if (state.agent.history.past.length > HISTORY_LIMIT) state.agent.history.past.shift();
  state.agent.history.future = [];
  updateUndoRedoButtons();
}

function commitGraphMutation(mutate, { render = true, save = true } = {}) {
  const snapshot = graphSnapshot();
  mutate(agentGraph());
  pushHistorySnapshot(snapshot);
  if (render) renderAgentCanvas();
  if (save) scheduleAgentSave();
}

function restoreGraph(snapshot) {
  try {
    state.agent.graph = normalizeAgentGraph(JSON.parse(snapshot));
  } catch (_) {
    showToast("撤销历史已损坏", "error");
    return;
  }
  if (!agentNode(state.agent.selectedNodeId)) {
    state.agent.selectedNodeId = null;
    clearAgentInspector();
  } else {
    selectAgentNode(state.agent.selectedNodeId);
  }
  renderAgentCanvas();
  scheduleAgentSave();
}

function undoAgent() {
  if (state.agent.running) {
    showToast("Agent 运行中，暂不能撤销图修改", "warning");
    return;
  }
  if (!state.agent.history.past.length) return;
  const current = graphSnapshot();
  const previous = state.agent.history.past.pop();
  state.agent.history.future.push(current);
  restoreGraph(previous);
  updateUndoRedoButtons();
}

function redoAgent() {
  if (state.agent.running) {
    showToast("Agent 运行中，暂不能重做图修改", "warning");
    return;
  }
  if (!state.agent.history.future.length) return;
  const current = graphSnapshot();
  const next = state.agent.history.future.pop();
  state.agent.history.past.push(current);
  restoreGraph(next);
  updateUndoRedoButtons();
}

function setAgentNext(sourceId, targetId) {
  const graph = agentGraph();
  graph.edges = graph.edges.filter((edge) => edge.from !== sourceId && (!targetId || edge.to !== targetId));
  if (targetId) graph.edges.push({ from: sourceId, to: targetId });
}

function wouldCreateCycle(sourceId, targetId) {
  let current = targetId;
  const seen = new Set();
  while (current) {
    if (current === sourceId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    current = agentNext(current);
  }
  return false;
}

function connectCandidates(sourceId) {
  const graph = agentGraph();
  if (!graph) return [];
  const incoming = new Map(graph.edges.map((edge) => [edge.to, edge.from]));
  return graph.nodes.filter((node) => {
    if (node.id === sourceId) return false;
    if (wouldCreateCycle(sourceId, node.id)) return false;
    const predecessor = incoming.get(node.id);
    return !predecessor || predecessor === sourceId;
  });
}

function sanitizeRetryConfigs() {
  const graph = agentGraph();
  if (!graph) return 0;
  const order = agentChainOrder();
  let removed = 0;
  graph.nodes.forEach((node) => {
    if (!node.retry) return;
    const nodeIndex = order.indexOf(node.id);
    const targetIndex = order.indexOf(node.retry.target);
    if (node.type !== "verify" || nodeIndex < 0 || targetIndex < 0 || targetIndex >= nodeIndex) {
      delete node.retry;
      removed += 1;
    }
  });
  if (removed) {
    const selected = agentNode(state.agent.selectedNodeId);
    if (selected?.type === "verify") renderRetryInspector(selected);
  }
  return removed;
}

function upstreamModelNodes(nodeId) {
  const order = agentChainOrder();
  const index = order.indexOf(nodeId);
  if (index < 0) return [];
  return order.slice(0, index).map(agentNode).filter((node) => node?.type === "model");
}

function updateNodeCard(node) {
  const card = document.querySelector(`.agent-node[data-node-id="${node.id}"]`);
  if (!card) return;
  const title = $(".agent-node-title", card);
  const preview = $(".agent-node-preview", card);
  if (title) title.textContent = node.title;
  if (preview) preview.textContent = node.prompt.replaceAll(/\s+/g, " ").trim();
}

function renderAgentFlowList() {
  const container = $("#agent-flow-list");
  if (!container) return;
  const graph = agentGraph();
  if (!graph) {
    container.textContent = "流程尚未载入。";
    return;
  }
  container.replaceChildren();
  const addItem = (label, title, detail, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-flow-item";
    const tag = document.createElement("span");
    tag.className = "agent-flow-tag";
    tag.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = title;
    const small = document.createElement("small");
    small.textContent = detail;
    button.append(tag, strong, small);
    if (onClick) button.addEventListener("click", onClick);
    container.append(button);
  };
  addItem("FIXED INPUT", "Task Spec", "只读 · 点击查看完整规格", () => openAgentFixedDialog("spec"));
  const chain = agentChainOrder();
  const ids = chain.length ? chain : graph.nodes.map((node) => node.id);
  ids.forEach((id) => {
    const node = agentNode(id);
    if (!node) return;
    let detail = "固定步骤 · 只读";
    if (node.id === "tester") detail = "PASS 结束；FAIL → Modifier 修复后重测";
    if (node.id === "modifier") detail = "修复 RTL 后回到 Tester 重新验证";
    addItem(node.type.toUpperCase(), node.title, detail, () => selectAgentNode(node.id));
  });
  addItem("FIXED OUTPUT", "Result Summary", "只读 · 点击查看最终结果", () => openAgentFixedDialog("summary"));
}

function selectAgentNode(nodeId) {
  const node = agentNode(nodeId);
  if (!node) return;
  state.agent.selectedNodeId = nodeId;
  $("#selected-node-type").textContent = node.type.toUpperCase();
  $("#agent-inspector-empty").classList.add("hidden");
  $("#agent-node-detail").classList.remove("hidden");
  const chip = $("#inspector-type-chip");
  chip.className = `inspector-type-chip type-${node.type}`;
  chip.textContent = `${node.type.toUpperCase()} NODE${node.id === agentGraph().entry ? " · ENTRY" : ""}`;
  $("#agent-detail-title").textContent = node.title;
  $("#agent-detail-prompt").textContent = node.prompt;
  renderAgentToolChecklist(node);
  const retrySection = $("#agent-detail-retry-section");
  const retryText = $("#agent-detail-retry");
  if (node.retry) {
    retrySection.classList.remove("hidden");
    const target = agentNode(node.retry.target);
    retryText.textContent = `验证失败后进入「${target?.title || node.retry.target}」，最多 ${node.retry.max} 次；失败详情通过 {verify_feedback} 注入修改步骤。`;
  } else if (node.id === "tester") {
    retrySection.classList.remove("hidden");
    retryText.textContent = "Tester 通过则结束；失败时进入 Modifier 修复并重新测试。";
  } else {
    retrySection.classList.add("hidden");
  }
  document.querySelectorAll(".agent-node").forEach((element) => {
    element.classList.toggle("selected", element.dataset.nodeId === nodeId);
  });
  applyExecutionState();
}

function clearAgentInspector() {
  $("#selected-node-type").textContent = "NO NODE";
  $("#agent-inspector-empty").classList.remove("hidden");
  $("#agent-node-detail").classList.add("hidden");
  $("#inspector-type-chip").textContent = "";
  document.querySelectorAll(".agent-node").forEach((element) => element.classList.remove("selected"));
}

function renderRetryInspector(node) {
  const field = $("#agent-retry-field");
  if (node.type !== "verify") {
    field.classList.add("hidden");
    return;
  }
  field.classList.remove("hidden");
  const targets = upstreamModelNodes(node.id);
  const targetSelect = $("#agent-retry-target");
  targetSelect.replaceChildren();
  targets.forEach((candidate) => targetSelect.append(new Option(candidate.title, candidate.id)));
  const retry = node.retry && targets.some((candidate) => candidate.id === node.retry.target) ? node.retry : null;
  const enabled = Boolean(retry);
  $("#agent-retry-enabled").checked = enabled;
  $("#agent-retry-enabled").disabled = targets.length === 0;
  targetSelect.disabled = !enabled || targets.length === 0;
  $("#agent-retry-max").disabled = !enabled || targets.length === 0;
  if (retry) {
    targetSelect.value = retry.target;
    $("#agent-retry-max").value = retry.max;
  } else if (targets.length) {
    targetSelect.value = targets[targets.length - 1].id;
    $("#agent-retry-max").value = 2;
  }
}

function renderAgentSpec() {
  // Spec 现在以固定节点显示在画布左上角；保留空函数兼容旧调用。
}

function fixedResultPreview(result) {
  if (!result) return "尚未运行 Agent。";
  const metrics = result.metrics || {};
  const parts = [result.summary || (result.passed ? "最终验收通过。" : "最终验收未通过。")];
  if (metrics.area !== undefined) parts.push(`Area ${Number(metrics.area).toFixed(3)}`);
  if (metrics.power_status === "ok") parts.push(`Power ${(Number(metrics.total_power_w) * 1e6).toFixed(3)} µW`);
  return parts.join(" · ");
}

function updateFixedSummaryNode(result) {
  const node = document.querySelector('.agent-node.fixed-summary');
  if (!node) return;
  const badge = node.querySelector("[data-fixed-badge]");
  const preview = node.querySelector("[data-fixed-preview]");
  if (badge) {
    if (!result) {
      badge.textContent = "NO RUN";
      badge.className = "fixed-badge neutral";
    } else {
      badge.textContent = result.passed ? "PASS" : "FAIL";
      badge.className = `fixed-badge ${result.passed ? "pass" : "fail"}`;
    }
  }
  if (preview) preview.textContent = fixedResultPreview(result);
  node.classList.toggle("pass", result?.passed === true);
  node.classList.toggle("fail", result?.passed === false);
}

function renderAgentResult(result) {
  state.agent.result = result || null;
  updateFixedSummaryNode(state.agent.result);
}

function fixedNodePositions() {
  const graph = agentGraph();
  if (!graph || !graph.nodes.length) return null;
  const xs = graph.nodes.map((node) => Number(node.x) || 0);
  const ys = graph.nodes.map((node) => Number(node.y) || 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxRight = Math.max(...xs.map((x) => x + NODE_W));
  const fixedY = Math.max(8, minY - FIXED_NODE_H - 24);
  const specX = Math.max(8, minX);
  const summaryX = Math.max(specX + FIXED_NODE_W + 40, maxRight - FIXED_NODE_W);
  return {
    spec: { x: specX, y: fixedY },
    summary: { x: summaryX, y: fixedY },
  };
}

function firstSpecPreview() {
  const lines = String(state.agent.spec || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, 2).join(" · ") || "尚未载入任务 Spec。";
}

function createFixedAgentNode(kind, position) {
  const isSpec = kind === "spec";
  const element = document.createElement("div");
  element.className = `agent-node fixed-node fixed-${kind}`;
  element.dataset.fixedNode = kind;
  element.style.left = `${position.x}px`;
  element.style.top = `${position.y}px`;
  element.tabIndex = 0;
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", isSpec ? "查看固定输入 Spec" : "查看固定输出 Summary");
  element.innerHTML = `
    <div class="agent-node-head">
      <span class="node-glyph ${isSpec ? "spec-glyph" : "report-glyph"}">${isSpec ? "▤" : "≡"}</span>
      <div class="agent-node-heading">
        <span class="agent-node-type">${isSpec ? "FIXED INPUT" : "FIXED OUTPUT"}</span>
        <span class="agent-node-title">${isSpec ? "Task Spec" : "Result Summary"}</span>
      </div>
      <span data-fixed-badge class="fixed-badge neutral">${isSpec ? "READ ONLY" : "NO RUN"}</span>
    </div>
    <div class="agent-node-preview" data-fixed-preview></div>
    <div class="agent-node-foot"><span class="muted">只读 · 点击查看</span></div>
  `;
  const preview = $("[data-fixed-preview]", element);
  if (isSpec) {
    preview.textContent = firstSpecPreview();
  } else {
    const result = state.agent.result;
    const badge = $("[data-fixed-badge]", element);
    if (result) {
      badge.textContent = result.passed ? "PASS" : "FAIL";
      badge.className = `fixed-badge ${result.passed ? "pass" : "fail"}`;
      element.classList.toggle("pass", result.passed === true);
      element.classList.toggle("fail", result.passed === false);
    }
    preview.textContent = fixedResultPreview(result);
  }
  element.addEventListener("click", () => openAgentFixedDialog(kind));
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAgentFixedDialog(kind);
    }
  });
  return element;
}

function renderAgentFixedNodes(layer) {
  const positions = fixedNodePositions();
  if (!positions) return;
  layer.append(createFixedAgentNode("spec", positions.spec));
  layer.append(createFixedAgentNode("summary", positions.summary));
}

function openAgentFixedDialog(kind) {
  const title = $("#agent-fixed-title");
  const label = $("#agent-fixed-kind");
  const content = $("#agent-fixed-content");
  if (!title || !label || !content) return;
  if (kind === "spec") {
    label.textContent = "FIXED INPUT · TASK SPEC";
    title.textContent = "任务 Spec（只读）";
    content.textContent = state.agent.spec || "尚未载入任务 Spec。";
  } else {
    label.textContent = "FIXED OUTPUT · FINAL RESULT";
    title.textContent = "最终 Summary（只读）";
    const result = state.agent.result;
    if (!result) {
      content.textContent = "尚未运行 Agent。运行结束后，这里会显示最终教师 TB、面积与功耗结果。";
    } else {
      const metrics = result.metrics || {};
      const lines = [
        `Result: ${result.passed ? "PASS" : "FAIL"}`,
        `Stage: ${result.stage || "—"}`,
        `Summary: ${result.summary || "—"}`,
      ];
      if (metrics.area !== undefined) lines.push(`Area: ${Number(metrics.area).toFixed(3)} ${metrics.area_unit || ""}`.trim());
      if (metrics.power_status === "ok") {
        lines.push(`Total power: ${(Number(metrics.total_power_w) * 1e6).toFixed(3)} µW`);
        if (metrics.internal_power_w !== undefined) lines.push(`Internal: ${(Number(metrics.internal_power_w) * 1e6).toFixed(3)} µW`);
        if (metrics.switching_power_w !== undefined) lines.push(`Switching: ${(Number(metrics.switching_power_w) * 1e6).toFixed(3)} µW`);
        if (metrics.leakage_power_w !== undefined) lines.push(`Leakage: ${(Number(metrics.leakage_power_w) * 1e6).toFixed(3)} µW`);
      }
      if (result.plan?.modules?.length) {
        lines.push("", "Plan:");
        result.plan.modules.forEach((module) => lines.push(`- ${module.name} → ${module.file}`));
      }
      if (Array.isArray(result.files) && result.files.length) {
        lines.push("", "Generated files:");
        result.files.forEach((file) => lines.push(`- ${file.path} (${file.bytes} bytes)`));
      }
      if (result.parser_rounds) lines.push(`Parser rounds: ${result.parser_rounds}`);
      if (result.tester_attempts) lines.push(`Tester attempts: ${result.tester_attempts}`);
      if (Array.isArray(result.supplements) && result.supplements.length) {
        lines.push("", "User supplements:");
        result.supplements.forEach((item) => lines.push(`- ${item}`));
      }
      const report = state.agent.run?.report;
      const checks = report?.checks || [];
      if (checks.length) {
        lines.push("", "Failed checks:");
        checks.slice(0, 8).forEach((check) => lines.push(`- ${check.name}: ${check.detail || ""}`));
      }
      lines.push("", "Metrics:", JSON.stringify(metrics, null, 2));
      content.textContent = lines.join("\n");
    }
  }
  $("#agent-fixed-dialog").showModal();
}

function renderAgentToolChecklist(node) {
  const section = $("#agent-detail-tools-section");
  const list = $("#agent-detail-tools");
  if (!section || !list) return;
  if (!node || node.type !== "model") {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  list.replaceChildren();
  const selected = new Set(Array.isArray(node.tools) ? node.tools : []);
  const labels = new Map();
  (state.agent.catalog.builtin || []).forEach((tool) => labels.set(tool.name, tool.title));
  (state.agent.skills || []).forEach((skill) => labels.set(`skill_${skill.name}`, `Skill · ${skill.title}`));
  if (!selected.size) {
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = "未启用工具 / skills（仅一次性生成）。";
    list.append(hint);
    return;
  }
  [...selected].forEach((name) => {
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.textContent = labels.get(name) || name;
    list.append(chip);
  });
}

function renderAgentSkills() {
  const container = $("#agent-skill-list");
  if (!container) return;
  container.replaceChildren();
  const skills = state.agent.skills || [];
  if (!skills.length) {
    container.className = "skill-list empty-copy";
    container.textContent = "尚无 skills，点击右上角新建。";
    return;
  }
  container.className = "skill-list";
  skills.forEach((skill) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "skill-item";
    const title = document.createElement("strong");
    title.textContent = skill.title;
    const description = document.createElement("small");
    description.textContent = skill.available ? skill.description : `${skill.description}（缺少 ${skill.entry}）`;
    button.append(title, description);
    container.append(button);
  });
}

async function loadAgentSkills() {
  const payload = await api("/api/agent/skills");
  state.agent.skills = payload.skills || [];
  state.agent.catalog.skills = state.agent.skills;
  renderAgentSkills();
  const selected = agentNode(state.agent.selectedNodeId);
  if (selected) renderAgentToolChecklist(selected);
}

async function openSkillDialog(skill = null) {
  if (state.agent.running) {
    showToast("Agent 运行中，暂不能编辑 Skill", "warning");
    return;
  }
  let detail = skill;
  if (skill) {
    try {
      detail = await api(`/api/agent/skills/${encodeURIComponent(skill.name)}`);
    } catch (error) {
      showToast(error.message, "error");
      return;
    }
  }
  state.agent.skillEditing = detail?.name || null;
  $("#skill-dialog-title").textContent = detail ? `编辑 Skill · ${detail.name}` : "新建 Python Skill";
  $("#skill-name").value = detail?.name || "";
  $("#skill-name").disabled = Boolean(detail);
  $("#skill-title").value = detail?.title || "";
  $("#skill-description").value = detail?.description || "";
  $("#skill-parameters").value = JSON.stringify(detail?.parameters || {
    type: "object",
    properties: { input: { type: "string", description: "Skill 的文本输入" } },
    additionalProperties: true,
  }, null, 2);
  $("#skill-code").value = detail?.code || "";
  $("#skill-status").textContent = detail ? "" : "保存后会出现在 Model 节点的可用工具列表中。";
  $("#skill-delete").classList.toggle("hidden", !detail);
  $("#skill-dialog").showModal();
}

async function saveSkillFromDialog(event) {
  event.preventDefault();
  const name = $("#skill-name").value.trim();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) {
    $("#skill-status").textContent = "名称必须以小写字母开头，只包含小写字母、数字、下划线";
    return;
  }
  let parameters;
  try {
    parameters = JSON.parse($("#skill-parameters").value || "{}");
  } catch (error) {
    $("#skill-status").textContent = `参数 JSON 无效：${error.message}`;
    return;
  }
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    $("#skill-status").textContent = "参数 JSON 必须是对象";
    return;
  }
  const payload = {
    title: $("#skill-title").value.trim() || name,
    description: $("#skill-description").value.trim(),
    code: $("#skill-code").value,
    parameters,
  };
  $("#skill-save").disabled = true;
  $("#skill-status").textContent = "正在保存…";
  try {
    const editing = state.agent.skillEditing;
    if (editing && editing !== name) {
      await api(`/api/agent/skills/${encodeURIComponent(editing)}`, { method: "DELETE" });
    }
    await api(`/api/agent/skills/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    await loadAgentSkills();
    $("#skill-dialog").close();
    showToast(`Skill ${name} 已保存`, "success");
  } catch (error) {
    $("#skill-status").textContent = error.message;
  } finally {
    $("#skill-save").disabled = false;
  }
}

async function deleteSkillFromDialog() {
  const name = state.agent.skillEditing;
  if (!name) return;
  const approved = await confirmAction("删除 Skill", `删除 Skill“${name}”及其 Python 文件？`, "删除");
  if (!approved) return;
  try {
    await api(`/api/agent/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    await loadAgentSkills();
    $("#skill-dialog").close();
    showToast(`Skill ${name} 已删除`, "success");
  } catch (error) {
    $("#skill-status").textContent = error.message;
  }
}

function updateSelectedAgentNodeDraft(renderCanvas = false) {
  const node = agentNode(state.agent.selectedNodeId);
  if (!node) return;
  node.title = $("#agent-node-title").value.trim() || NODE_DEFAULTS[node.type].title;
  node.prompt = $("#agent-node-prompt").value;
  updateNodeCard(node);
  if (renderCanvas) {
    renderAgentCanvas();
  } else {
    drawAgentEdges();
  }
  updateDesignBadge();
  scheduleAgentSave();
}

function updateRetryFromInspector(previousSnapshot) {
  const node = agentNode(state.agent.selectedNodeId);
  if (!node || node.type !== "verify") return;
  const enabled = $("#agent-retry-enabled").checked;
  if (enabled) {
    const target = $("#agent-retry-target").value;
    const max = clamp(Number($("#agent-retry-max").value) || 2, 1, 5);
    if (!target) {
      $("#agent-retry-enabled").checked = false;
      showToast("请先添加位于 Verify 之前的 Model 节点", "warning");
      return;
    }
    node.retry = { target, max };
  } else {
    delete node.retry;
  }
  pushHistorySnapshot(previousSnapshot);
  renderAgentCanvas();
  scheduleAgentSave();
}

function deleteSelectedAgentNode() {
  const graph = agentGraph();
  const id = state.agent.selectedNodeId;
  if (!graph || !id) return;
  if (state.agent.running) {
    showToast("Agent 运行中，暂不能修改流程图", "warning");
    return;
  }
  if (id === graph.entry) {
    showToast("入口节点不能删除；可先连接新的入口节点后再调整", "warning");
    return;
  }
  commitGraphMutation((target) => {
    target.nodes = target.nodes.filter((node) => node.id !== id);
    target.edges = target.edges.filter((edge) => edge.from !== id && edge.to !== id);
    target.nodes.forEach((node) => {
      if (node.retry?.target === id) delete node.retry;
    });
  });
  state.agent.selectedNodeId = null;
  clearAgentInspector();
  renderAgentCanvas();
  showToast("节点已删除，可使用 ⌘Z 撤销", "success");
}

function duplicateSelectedAgentNode() {
  const node = agentNode(state.agent.selectedNodeId);
  const graph = agentGraph();
  if (!node || !graph) return;
  if (state.agent.running) {
    showToast("Agent 运行中，暂不能修改流程图", "warning");
    return;
  }
  const base = `${node.id}_copy`;
  let id = base;
  let index = 2;
  while (agentNode(id)) {
    id = `${base}${index}`;
    index += 1;
  }
  commitGraphMutation((target) => {
    const clone = {
      id,
      type: node.type,
      title: `${node.title} 副本`,
      prompt: node.prompt,
      x: node.x + 40,
      y: node.y + 40,
    };
    if (node.type === "model") clone.tools = [...(node.tools || [])];
    target.nodes.push(clone);
  });
  selectAgentNode(id);
  renderAgentCanvas();
  showToast("已复制节点", "success");
}

function addAgentNode(type, x, y) {
  const graph = agentGraph();
  if (!graph || !NODE_DEFAULTS[type]) return;
  if (state.agent.running) {
    showToast("Agent 运行中，暂不能修改流程图", "warning");
    return;
  }
  if (graph.nodes.length >= 16) {
    showToast("节点数不能超过 16 个", "warning");
    return;
  }
  const viewCenter = viewportCenterPoint();
  const baseX = x ?? viewCenter.x - NODE_W / 2 + (graph.nodes.length % 5) * 24;
  const baseY = y ?? viewCenter.y - NODE_H / 2 + (graph.nodes.length % 4) * 24;
  let id = `node_${Date.now().toString(36)}`;
  while (agentNode(id)) id = `${id}x`;
  commitGraphMutation((target) => {
    const newNode = {
      id,
      type,
      title: NODE_DEFAULTS[type].title,
      prompt: NODE_DEFAULTS[type].prompt,
      x: Math.max(0, Math.round(baseX / GRID) * GRID),
      y: Math.max(0, Math.round(baseY / GRID) * GRID),
    };
    if (type === "model") newNode.tools = [];
    target.nodes.push(newNode);
    if (!target.entry) target.entry = id;
  });
  selectAgentNode(id);
  renderAgentCanvas();
  applyView();
}

function autoLayoutGraph() {
  if (!agentGraph() || state.agent.running) return;
  const order = agentChainOrder();
  const remaining = agentGraph().nodes.map((node) => node.id).filter((id) => !order.includes(id));
  const ids = [...order, ...remaining];
  commitGraphMutation((graph) => {
    ids.forEach((id, index) => {
      const node = graph.nodes.find((candidate) => candidate.id === id);
      if (!node) return;
      node.x = 48 + index * (NODE_W + 72);
      node.y = 120;
    });
  }, { render: true });
  fitAgentView();
  showToast("已按执行顺序整理节点", "success");
}

async function resetAgentGraph() {
  if (state.agent.running) {
    showToast("Agent 运行中，暂不能重置流程图", "warning");
    return;
  }
  const approved = await confirmAction("恢复内置示例", "当前流程图会被内置的四节点示例替换，可从运行历史继续查看旧记录。", "恢复");
  if (!approved) return;
  const snapshot = graphSnapshot();
  state.agent.graph = JSON.parse(JSON.stringify(DEFAULT_AGENT_GRAPH));
  setCurrentDesign(null);
  pushHistorySnapshot(snapshot);
  state.agent.selectedNodeId = null;
  clearAgentInspector();
  renderAgentCanvas();
  fitAgentView();
  scheduleAgentSave();
  showToast("已恢复内置示例图", "success");
}

/* --------------------------- Agent canvas render --------------------------- */

function createAgentNode(node) {
  const [glyph, glyphClass] = NODE_GLYPHS[node.type] || ["?", "report-glyph"];
  const element = document.createElement("div");
  element.className = `agent-node type-${node.type}`;
  element.dataset.nodeId = node.id;
  element.style.left = `${node.x}px`;
  element.style.top = `${node.y}px`;
  element.innerHTML = `
    <div class="agent-node-head">
      <span class="node-glyph ${glyphClass}">${glyph}</span>
      <div class="agent-node-heading">
        <span class="agent-node-type">${escapeHtml(node.type.toUpperCase())}</span>
        <span class="agent-node-title"></span>
      </div>
      <span class="node-status-indicator" aria-hidden="true"></span>
    </div>
    <div class="agent-node-preview"></div>
    <div class="agent-node-foot">
      <span class="agent-entry-badge">ENTRY</span>
      <span class="agent-node-meta"></span>
    </div>
  `;
  $(".agent-node-title", element).textContent = node.title;
  const preview = node.prompt.replaceAll(/\s+/g, " ").trim();
  $(".agent-node-preview", element).textContent = preview;
  $(".agent-entry-badge", element).classList.toggle("hidden", node.id !== agentGraph().entry);
  element.tabIndex = 0;
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", `${node.type} 节点：${node.title}`);
  element.addEventListener("click", () => selectAgentNode(node.id));
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectAgentNode(node.id);
    }
  });
  return element;
}

function renderAgentCanvas() {
  const graph = agentGraph();
  if (!graph) return;
  $("#agent-name").textContent = graph.name;
  const layer = $("#agent-nodes");
  layer.replaceChildren();
  $("#canvas-empty").classList.toggle("hidden", graph.nodes.length > 0);
  graph.nodes.forEach((node) => layer.append(createAgentNode(node)));
  renderAgentFixedNodes(layer);
  $("#agent-graph-stats").textContent = `${graph.nodes.length} nodes · ${graph.edges.length} links`;
  const order = new Set(agentChainOrder());
  $$(".agent-node", layer).forEach((element) => {
    element.classList.toggle("unreachable", !order.has(element.dataset.nodeId));
  });
  drawAgentEdges();
  updateNodeStatuses();
  renderAgentFlowList();
}

function nodePoint(node, side) {
  if (side === "in") return { x: node.x, y: node.y + NODE_H / 2 };
  if (side === "bottom") return { x: node.x + NODE_W / 2, y: node.y + NODE_H };
  return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
}

function edgePath(from, to) {
  const bend = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

function retryEdgePath(fromNode, toNode) {
  const from = nodePoint(fromNode, "bottom");
  const to = nodePoint(toNode, "bottom");
  const dip = Math.max(64, Math.abs(to.x - from.x) * 0.18);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + dip}, ${to.x} ${to.y + dip}, ${to.x} ${to.y}`;
}

const HANDOFF_LABELS = {
  spec_to_parser: "固定 Spec → Parser",
  parser_to_planner: "Parser → Planner",
  planner_to_coder: "Planner → Coder",
  coder_to_tester: "Coder → Tester",
  tester_to_modifier: "Tester → Modifier",
  modifier_to_tester: "Modifier → Tester",
  tester_to_summary: "Tester → Summary",
};

function handoffEdgeId(source, target) {
  return `${source}_to_${target}`;
}

function addHandoffHitArea(svg, pathData, edgeId) {
  const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hit.setAttribute("d", pathData);
  hit.setAttribute("class", "agent-edge-hit");
  hit.dataset.handoff = edgeId;
  hit.addEventListener("click", (event) => {
    event.stopPropagation();
    openAgentHandoffDialog(edgeId);
  });
  svg.append(hit);
}

async function openAgentHandoffDialog(edgeId) {
  const runId = state.agent.run?.run_id || state.agent.job?.run_id;
  if (!runId) {
    showToast("请先运行一次 Agent，再点击箭头查看子 Agent 交接", "warning");
    return;
  }
  try {
    const payload = await api(
      `/api/agent/runs/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(edgeId)}`
    );
    renderAgentHandoffDialog(payload);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderAgentHandoffDialog(payload) {
  const dialog = $("#agent-handoff-dialog");
  const items = payload.items || [];
  if (!dialog || !items.length) return;
  $("#agent-handoff-title").textContent =
    HANDOFF_LABELS[payload.edge_id] || items[items.length - 1].label || payload.edge_id;
  const latest = items[items.length - 1];
  $("#agent-handoff-meta").textContent = `${payload.run_id} · ${items.length} 个交接版本 · ${latest.source || ""} → ${latest.target || ""}`;
  const tabs = $("#agent-handoff-tabs");
  tabs.replaceChildren();
  const content = $("#agent-handoff-content");
  const showItem = (index) => {
    const item = items[index];
    content.textContent = JSON.stringify(item.payload, null, 2);
    [...tabs.querySelectorAll(".handoff-tab")].forEach((button, position) => {
      button.classList.toggle("active", position === index);
    });
  };
  items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "handoff-tab";
    button.textContent = [
      item.attempt ? `第 ${item.attempt} 轮` : "latest",
      item.created_at ? String(item.created_at).slice(11, 19) : "",
    ].filter(Boolean).join(" · ");
    button.addEventListener("click", () => showItem(index));
    tabs.append(button);
  });
  showItem(items.length - 1);
  if (!dialog.open) dialog.showModal();
}

function drawAgentEdges() {
  const graph = agentGraph();
  const svg = $("#agent-edges");
  if (!graph || !svg) return;
  svg.setAttribute("viewBox", "0 0 4000 3000");
  $$("path.agent-edge, path.agent-edge-hit", svg).forEach((path) => path.remove());
  graph.edges.forEach((edge) => {
    const from = agentNode(edge.from);
    const to = agentNode(edge.to);
    if (!from || !to) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const pathData = edgePath(nodePoint(from, "out"), nodePoint(to, "in"));
    path.setAttribute("d", pathData);
    path.setAttribute("class", "agent-edge");
    path.setAttribute("marker-end", "url(#arrow-head)");
    path.dataset.edge = `${edge.from}->${edge.to}`;
    svg.append(path);
    addHandoffHitArea(svg, pathData, handoffEdgeId(edge.from, edge.to));
  });
  graph.nodes.forEach((node) => {
    if (node.type !== "verify" || !node.retry) return;
    const target = agentNode(node.retry.target);
    if (!target) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const pathData = retryEdgePath(node, target);
    path.setAttribute("d", pathData);
    path.setAttribute("class", "agent-edge retry-edge");
    path.setAttribute("marker-end", "url(#arrow-retry)");
    path.dataset.edge = `${node.id}->${node.retry.target}`;
    svg.append(path);
    addHandoffHitArea(svg, pathData, handoffEdgeId(node.id, node.retry.target));
  });
  applyExecutionState();
  $$("path.agent-fixed-edge", svg).forEach((path) => path.remove());
  const positions = fixedNodePositions();
  const chain = agentChainOrder();
  const entry = agentNode(graph.entry);
  const last = agentNode(chain[chain.length - 1] || graph.nodes[graph.nodes.length - 1]?.id);
  const tester = graph.nodes.find((node) => node.id === "tester");
  if (positions && entry && last) {
    const spec = positions.spec;
    const summary = positions.summary;
    const summarySource = tester || last;
    const fixedEdges = [
      {
        d: `M ${spec.x + FIXED_NODE_W / 2} ${spec.y + FIXED_NODE_H} C ${spec.x + FIXED_NODE_W / 2} ${spec.y + FIXED_NODE_H + 36}, ${entry.x + NODE_W / 2} ${entry.y - 36}, ${entry.x + NODE_W / 2} ${entry.y}`,
        id: "spec_to_parser",
      },
      {
        d: `M ${summarySource.x + NODE_W / 2} ${summarySource.y} C ${summarySource.x + NODE_W / 2} ${summarySource.y - 36}, ${summary.x + FIXED_NODE_W / 2} ${summary.y + FIXED_NODE_H + 36}, ${summary.x + FIXED_NODE_W / 2} ${summary.y + FIXED_NODE_H}`,
        id: "tester_to_summary",
      },
    ];
    fixedEdges.forEach((edge) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", edge.d);
      path.setAttribute("class", "agent-fixed-edge");
      svg.append(path);
      addHandoffHitArea(svg, edge.d, edge.id);
    });
  }

}

function updateNodeStatuses() {
  const states = new Map();
  state.agent.events.forEach((event) => {
    states.set(event.node_id, {
      status: event.status || (event.report ? (event.report.passed ? "passed" : "failed") : "info"),
      attempt: event.attempt || 1,
      duration: event.duration_ms,
    });
  });
  $$(".agent-node").forEach((element) => {
    const info = states.get(element.dataset.nodeId);
    element.classList.remove("status-running", "status-passed", "status-failed", "status-info");
    if (info) element.classList.add(`status-${info.status}`);
    const indicator = $(".node-status-indicator", element);
    if (indicator) {
      indicator.className = "node-status-indicator";
      indicator.textContent = "";
      if (info?.status === "running") indicator.classList.add("running");
      else if (info?.status === "passed") { indicator.classList.add("passed"); indicator.textContent = "✓"; }
      else if (info?.status === "failed") { indicator.classList.add("failed"); indicator.textContent = "×"; }
      else if (info?.status === "info") { indicator.classList.add("info"); indicator.textContent = "•"; }
    }
    const meta = $(".agent-node-meta", element);
    if (meta) {
      meta.textContent = info
        ? `第 ${info.attempt} 轮${info.duration ? ` · ${formatDuration(info.duration)}` : ""}`
        : "";
    }
  });
}

function updateNodeSelectionClasses() {
  $$(".agent-node").forEach((element) => {
    element.classList.toggle("selected", element.dataset.nodeId === state.agent.selectedNodeId);
  });
}

function selectedEvent() {
  return state.agent.events.find((event) => event.step === state.agent.selectedStep) || null;
}

function applyExecutionState() {
  updateNodeSelectionClasses();
  const events = state.agent.events;
  const selected = selectedEvent();
  const selectedIndex = selected ? events.findIndex((event) => event.step === selected.step) : -1;

  $$(".agent-node").forEach((element) => {
    element.classList.toggle("trace-node", selected?.node_id === element.dataset.nodeId);
  });

  const traversed = new Set();
  const retryTraversed = new Set();
  events.forEach((event) => {
    if (event.next) traversed.add(`${event.node_id}->${event.next}`);
    if (event.retry?.target) {
      retryTraversed.add(`${event.node_id}->${event.retry.target}`);
      traversed.add(`${event.node_id}->${event.retry.target}`);
    }
  });
  if (selectedIndex > 0) {
    const previous = events[selectedIndex - 1];
    traversed.add(`${previous.node_id}->${selected.node_id}`);
  }

  $$("path.agent-edge").forEach((path) => {
    const key = path.dataset.edge;
    path.classList.toggle("traversed", traversed.has(key));
    path.classList.toggle("retry-traversed", retryTraversed.has(key));
    path.classList.toggle("active", Boolean(selectedIndex > 0 && key === `${events[selectedIndex - 1].node_id}->${selected.node_id}`));
  });
}

/* ---------------------------- Canvas interaction ---------------------------- */

function applyView() {
  const canvas = $("#agent-canvas");
  if (!canvas) return;
  const { x, y, scale } = state.agent.view;
  canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  const zoomLabel = $("#agent-zoom-label");
  if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
}

function viewportCenterPoint() {
  const scroll = $("#agent-canvas-scroll");
  if (!scroll) return { x: 400, y: 240 };
  const rect = scroll.getBoundingClientRect();
  const { x, y, scale } = state.agent.view;
  return { x: (rect.width / 2 - x) / scale, y: (rect.height / 2 - y) / scale };
}

function clientToStage(clientX, clientY) {
  const canvas = $("#agent-canvas");
  const rect = canvas.getBoundingClientRect();
  const { scale } = state.agent.view;
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}

function zoomTo(clientX, clientY, targetScale) {
  const view = state.agent.view;
  const canvas = $("#agent-canvas");
  const scrollRect = canvas.parentElement.getBoundingClientRect();
  const rect = canvas.getBoundingClientRect();
  const stageX = (clientX - rect.left) / view.scale;
  const stageY = (clientY - rect.top) / view.scale;
  const nextScale = clamp(targetScale, MIN_SCALE, MAX_SCALE);
  if (Math.abs(nextScale - view.scale) < 0.0001) return;
  view.x = clientX - scrollRect.left - stageX * nextScale;
  view.y = clientY - scrollRect.top - stageY * nextScale;
  view.scale = nextScale;
  state.agent.needsFit = false;
  applyView();
}

function zoomAt(clientX, clientY, factor) {
  zoomTo(clientX, clientY, state.agent.view.scale * factor);
}

function zoomBy(factor) {
  const scroll = $("#agent-canvas-scroll");
  const rect = scroll.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function resetZoom() {
  const scroll = $("#agent-canvas-scroll");
  const rect = scroll.getBoundingClientRect();
  zoomTo(rect.left + rect.width / 2, rect.top + rect.height / 2, 1);
}

function fitAgentView() {
  const graph = agentGraph();
  const scroll = $("#agent-canvas-scroll");
  if (!graph || !scroll) return;
  if (!graph.nodes.length) {
    state.agent.view = { x: 48, y: 48, scale: 1 };
    applyView();
    return;
  }
  const positions = fixedNodePositions();
  const xs = graph.nodes.map((node) => node.x);
  const ys = graph.nodes.map((node) => node.y);
  const rights = graph.nodes.map((node) => node.x + NODE_W);
  const bottoms = graph.nodes.map((node) => node.y + NODE_H);
  if (positions) {
    xs.push(positions.spec.x, positions.summary.x);
    ys.push(positions.spec.y, positions.summary.y);
    rights.push(positions.spec.x + FIXED_NODE_W, positions.summary.x + FIXED_NODE_W);
    bottoms.push(positions.spec.y + FIXED_NODE_H, positions.summary.y + FIXED_NODE_H);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...rights);
  const maxY = Math.max(...bottoms);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const padding = 72;
  const availableWidth = Math.max(200, scroll.clientWidth - padding * 2);
  const availableHeight = Math.max(180, scroll.clientHeight - padding * 2);
  const scale = clamp(Math.min(availableWidth / width, availableHeight / height), MIN_SCALE, 1.15);
  state.agent.view = {
    scale,
    x: (scroll.clientWidth - width * scale) / 2 - minX * scale,
    y: (scroll.clientHeight - height * scale) / 2 - minY * scale,
  };
  state.agent.needsFit = false;
  applyView();
}

function bindNodeDrag(element, node) {
  let drag = null;
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".node-port") || state.agent.running) return;
    event.preventDefault();
    clearTimeout(state.agent.saveTimer);
    element.setPointerCapture(event.pointerId);
    drag = {
      startX: event.clientX,
      startY: event.clientY,
      nodeX: Number(node.x),
      nodeY: Number(node.y),
      moved: false,
      snapshot: graphSnapshot(),
    };
    element.classList.add("dragging");
  });
  element.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const scale = state.agent.view.scale;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    node.x = Math.max(0, Math.round((drag.nodeX + dx) / GRID) * GRID);
    node.y = Math.max(0, Math.round((drag.nodeY + dy) / GRID) * GRID);
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    drawAgentEdges();
  });
  const release = (event) => {
    if (!drag) return;
    element.classList.remove("dragging");
    if (drag.moved) {
      pushHistorySnapshot(drag.snapshot);
      scheduleAgentSave();
      state.agent.needsFit = false;
    } else {
      selectAgentNode(node.id);
    }
    drag = null;
    try { element.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
  };
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
}

function bindPortConnection(port, node) {
  port.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.agent.running) return;
    event.preventDefault();
    event.stopPropagation();
    const from = nodePoint(node, "out");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "agent-edge connection-preview");
    path.setAttribute("d", `M ${from.x} ${from.y} L ${from.x} ${from.y}`);
    $("#agent-edges").append(path);

    const move = (moveEvent) => {
      const point = clientToStage(moveEvent.clientX, moveEvent.clientY);
      path.setAttribute("d", edgePath(from, point));
    };
    const up = (upEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      path.remove();
      const targetElement = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest(".agent-node");
      const targetId = targetElement?.dataset.nodeId;
      if (!targetId || targetId === node.id) {
        drawAgentEdges();
        return;
      }
      if (wouldCreateCycle(node.id, targetId)) {
        showToast("该连线会形成环路，请改用 Verify 重试配置", "warning");
        drawAgentEdges();
        return;
      }
      const predecessor = agentGraph().edges.find((edge) => edge.to === targetId && edge.from !== node.id);
      if (predecessor) {
        showToast("目标节点已有前驱；请先删除旧连线或使用 Verify 重试", "warning");
        drawAgentEdges();
        return;
      }
      commitGraphMutation((graph) => {
        graph.edges = graph.edges.filter((edge) => edge.from !== node.id);
        graph.edges.push({ from: node.id, to: targetId });
      });
      if (sanitizeRetryConfigs()) {
        renderAgentCanvas();
        scheduleAgentSave();
        showToast("连线变更使原有重试配置失效，已自动移除", "warning");
      }
      if (state.agent.selectedNodeId === node.id) selectAgentNode(node.id);
      showToast(`已连接 ${node.title} → ${agentNode(targetId)?.title || targetId}`, "success");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function bindCanvasPanAndZoom() {
  const scroll = $("#agent-canvas-scroll");
  const canvas = $("#agent-canvas");
  if (!scroll || !canvas) return;
  let pan = null;

  canvas.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".agent-node")) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    pan = {
      startX: event.clientX,
      startY: event.clientY,
      viewX: state.agent.view.x,
      viewY: state.agent.view.y,
      moved: false,
    };
    scroll.classList.add("panning");
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pan) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    state.agent.view.x = pan.viewX + dx;
    state.agent.view.y = pan.viewY + dy;
    applyView();
  });
  const release = () => {
    if (!pan) return;
    scroll.classList.remove("panning");
    if (!pan.moved) {
      state.agent.selectedNodeId = null;
      clearAgentInspector();
      applyExecutionState();
    }
    state.agent.needsFit = false;
    pan = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  scroll.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 0.89);
    } else {
      state.agent.view.x -= event.deltaX;
      state.agent.view.y -= event.deltaY;
      state.agent.needsFit = false;
      applyView();
    }
  }, { passive: false });

  canvas.addEventListener("dblclick", (event) => {
    if (event.target.closest(".agent-node")) return;
    fitAgentView();
  });
}

/* ----------------------------- Agent inspector ----------------------------- */

function insertPromptVariable(variable) {
  const textarea = $("#agent-node-prompt");
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  textarea.setRangeText(variable, start, end, "end");
  textarea.focus();
  updateSelectedAgentNodeDraft(false);
}

function bindInspector() {
  const form = $("#agent-node-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const snapshot = state.agent.history.editSnapshot;
    updateSelectedAgentNodeDraft(true);
    pushHistorySnapshot(snapshot);
    state.agent.history.editSnapshot = null;
    renderAgentCanvas();
    saveAgentGraph().then(() => showToast("节点已保存", "success")).catch(() => {});
  });
  $("#agent-delete-node").addEventListener("click", deleteSelectedAgentNode);
  $("#agent-duplicate-node").addEventListener("click", duplicateSelectedAgentNode);
  $("#agent-node-title").addEventListener("input", () => updateSelectedAgentNodeDraft(false));
  $("#agent-node-prompt").addEventListener("input", () => updateSelectedAgentNodeDraft(false));
  ["#agent-node-title", "#agent-node-prompt"].forEach((selector) => {
    const input = $(selector);
    input.addEventListener("focusin", () => {
      if (!state.agent.history.editSnapshot) state.agent.history.editSnapshot = graphSnapshot();
    });
    input.addEventListener("focusout", () => {
      pushHistorySnapshot(state.agent.history.editSnapshot);
      state.agent.history.editSnapshot = null;
    });
  });
  $("#agent-node-next").addEventListener("change", (event) => {
    const node = agentNode(state.agent.selectedNodeId);
    if (!node) return;
    const snapshot = graphSnapshot();
    setAgentNext(node.id, event.target.value);
    pushHistorySnapshot(snapshot);
    renderAgentCanvas();
    if (sanitizeRetryConfigs()) {
      renderAgentCanvas();
      showToast("连线变更使原有重试配置失效，已自动移除", "warning");
    }
    scheduleAgentSave();
  });
  $("#agent-retry-enabled").addEventListener("change", () => {
    const snapshot = graphSnapshot();
    const targets = upstreamModelNodes(state.agent.selectedNodeId);
    $("#agent-retry-target").disabled = !$("#agent-retry-enabled").checked || targets.length === 0;
    $("#agent-retry-max").disabled = !$("#agent-retry-enabled").checked || targets.length === 0;
    updateRetryFromInspector(snapshot);
  });
  $("#agent-retry-target").addEventListener("change", () => {
    const snapshot = graphSnapshot();
    updateRetryFromInspector(snapshot);
  });
  $("#agent-retry-max").addEventListener("change", () => {
    const snapshot = graphSnapshot();
    updateRetryFromInspector(snapshot);
  });
  $$("#agent-variable-bar [data-var]").forEach((button) => {
    button.addEventListener("click", () => insertPromptVariable(button.dataset.var));
  });
}

/* ------------------------------ Agent console ------------------------------ */

function eventStatus(event) {
  if (event.status === "running") return "running";
  if (event.status) return event.status;
  return event.report ? (event.report.passed ? "passed" : "failed") : "info";
}

function renderAgentEvents() {
  const list = $("#agent-events");
  const events = state.agent.events;
  $("#agent-event-count").textContent = String(events.length);
  list.replaceChildren();
  if (!events.length) {
    list.className = "agent-events empty-copy";
    list.textContent = "运行后会在此实时列出每一步。";
    renderAgentPhaseStrip();
    renderAgentEventDetail();
    return;
  }
  list.className = "agent-events";
  renderAgentPhaseStrip();
  events.forEach((event) => {
    const status = eventStatus(event);
    const [label, badge] = statusMeta(status);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-event type-${event.node_type} status-${status} ${event.step === state.agent.selectedStep ? "active" : ""}`;
    button.innerHTML = `
      <span class="event-step">${String(event.step).padStart(2, "0")}</span>
      <span class="event-main">
        <strong></strong>
        <small></small>
      </span>
      <span class="event-result ${badge}">${label}</span>
    `;
    $("strong", button).textContent = event.title;
    const parts = [
      event.node_type.toUpperCase(),
      `attempt ${event.attempt || 1}`,
      formatDuration(event.duration_ms),
      formatTokens(event.usage),
    ].filter(Boolean);
    if (event.retry) {
      parts.push(event.retry.exhausted ? "retry exhausted" : `retry → ${event.retry.attempt}`);
    }
    $("small", button).textContent = parts.join(" · ");
    button.addEventListener("click", () => selectAgentStep(event.step));
    list.append(button);
  });
  if (state.agent.followLive) {
    const active = list.querySelector(".agent-event.active");
    active?.scrollIntoView({ block: "nearest" });
  }
  renderAgentEventDetail();
}

function updateFollowLiveButton() {
  const button = $("#agent-follow-live");
  button.classList.toggle("active", state.agent.followLive);
  button.textContent = state.agent.followLive ? "跟随中" : "跟随最新";
}

function detailText(event) {
  if (!event) return "选择一个运行步骤后，将在这里显示详细内容。";
  if (event.status === "running" && !event.response && state.agent.detailTab !== "prompt") {
    return "该步骤正在执行，完成后会自动刷新。";
  }
  if (state.agent.detailTab === "prompt") return event.prompt || "该步骤没有 Prompt。";
  if (state.agent.detailTab === "reasoning") return event.reasoning || "该步骤未返回可展示的模型推理文本。";
  if (state.agent.detailTab === "rtl") {
    if (event.rtl) return event.rtl;
    if (event.report) return JSON.stringify(event.report, null, 2);
    return "该步骤没有 RTL 或 TB 数据。";
  }
  if (state.agent.detailTab === "tools") {
    const calls = event.tool_calls || [];
    if (calls.length) return JSON.stringify(calls, null, 2);
    return "该步骤没有调用工具。";
  }
  if (event.error) return `执行失败：${event.error}`;
  return event.response || (event.report ? JSON.stringify(event.report, null, 2) : "该步骤没有输出。");
}

const AGENT_PHASES = [
  { id: "parser", label: "Parser", hint: "Spec 完整性" },
  { id: "planner", label: "Planner", hint: "模块/文件规划" },
  { id: "coder", label: "Coder", hint: "逐文件 RTL" },
  { id: "tester", label: "Tester", hint: "TB + 面积/功耗" },
  { id: "modifier", label: "Modifier", hint: "失败修复" },
];

function phaseStatusText(event) {
  if (!event) return "待执行";
  if (event.status === "waiting_input") return "等待补充";
  if (event.status === "running") return "执行中";
  if (event.status === "passed") return "PASS";
  if (event.status === "failed") return "FAIL";
  return "完成";
}

function renderAgentPhaseStrip() {
  const strip = $("#agent-phase-strip");
  if (!strip) return;
  strip.replaceChildren();
  AGENT_PHASES.forEach((phase, index) => {
    const events = state.agent.events.filter((event) => event.node_id === phase.id);
    const event = events[events.length - 1];
    const status = event ? eventStatus(event) : "idle";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-phase status-${status} ${event && event.step === state.agent.selectedStep ? "active" : ""}`;
    button.disabled = !event;
    const tag = document.createElement("span");
    tag.className = "phase-index";
    tag.textContent = String(index + 1).padStart(2, "0");
    const main = document.createElement("span");
    main.className = "phase-main";
    const title = document.createElement("strong");
    title.textContent = phase.label;
    const hint = document.createElement("small");
    const attempts = events.length ? Math.max(...events.map((item) => Number(item.attempt) || 1)) : 0;
    hint.textContent = event
      ? `${phase.hint}${attempts > 1 ? ` · 第 ${attempts} 轮` : ""}`
      : phase.hint;
    main.append(title, hint);
    const stateChip = document.createElement("span");
    stateChip.className = "phase-state";
    stateChip.textContent = phaseStatusText(event);
    button.append(tag, main, stateChip);
    if (event) button.addEventListener("click", () => selectAgentStep(event.step));
    strip.append(button);
    if (index < AGENT_PHASES.length - 1) {
      const arrow = document.createElement("span");
      arrow.className = "phase-arrow";
      arrow.textContent = "→";
      strip.append(arrow);
    }
  });
}

function selectAgentStep(step) {
  state.agent.selectedStep = step;
  state.agent.followLive = false;
  updateFollowLiveButton();
  renderAgentEvents();
  applyExecutionState();
}

function parseEventJson(event) {
  const raw = event?.raw_response || event?.response || "";
  if (!raw) return null;
  const stripped = raw.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function detailSection(container, title) {
  const section = document.createElement("section");
  section.className = "trace-detail-section";
  if (title) {
    const heading = document.createElement("h4");
    heading.textContent = title;
    section.append(heading);
  }
  container.append(section);
  return section;
}

function detailPre(section, text, className = "") {
  const pre = document.createElement("pre");
  pre.className = `trace-detail-code ${className}`.trim();
  pre.textContent = text || "—";
  section.append(pre);
  return pre;
}

function detailList(section, items) {
  if (!items?.length) return;
  const list = document.createElement("ul");
  list.className = "trace-detail-list";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = String(item);
    list.append(li);
  });
  section.append(list);
}

function detailPills(section, items) {
  if (!items?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "trace-detail-pills";
  items.forEach((item) => {
    const pill = document.createElement("span");
    pill.textContent = `${item.name} → ${item.file}`;
    wrap.append(pill);
  });
  section.append(wrap);
}

function renderParserDetail(container, event) {
  const parsed = parseEventJson(event) || {};
  const verdict = document.createElement("div");
  verdict.className = `trace-verdict ${parsed.sufficient ? "pass" : "warn"}`;
  verdict.textContent = parsed.sufficient ? "Spec 已足够" : "Spec 仍需补充";
  container.append(verdict);
  const missing = parsed.missing || event.input_request?.missing || [];
  const questions = parsed.questions || event.input_request?.questions || [];
  if (missing.length) {
    const section = detailSection(container, "缺失内容");
    detailList(section, missing);
  }
  if (questions.length) {
    const section = detailSection(container, "需要用户回答的问题");
    detailList(section, questions);
  }
  if (event.input_response) {
    const section = detailSection(container, "用户补充");
    detailPre(section, event.input_response);
  }
  if (parsed.refined_spec) {
    const section = detailSection(container, "Parser 规范化后的 Spec");
    detailPre(section, parsed.refined_spec);
  }
  if (!missing.length && !questions.length && !event.input_response) {
    const section = detailSection(container, "结论");
    detailPre(section, event.response || "Spec 充分。");
  }
}

function renderPlannerDetail(container, event) {
  const plan = parseEventJson(event) || {};
  if (!plan.modules?.length) {
    const section = detailSection(container, "规划结果");
    detailPre(section, event.response || "Planner 暂无输出。");
    return;
  }
  const meta = detailSection(container, "项目");
  detailPre(meta, `project: ${plan.project_name || "—"}\ntop_module: ${plan.top_module || "—"}`);
  const modules = detailSection(container, "模块 / 文件结构");
  detailPills(modules, plan.modules);
  if (plan.notes) {
    const notes = detailSection(container, "说明");
    detailPre(notes, plan.notes);
  }
}

function renderTesterDetail(container, event) {
  const report = event.report || {};
  const verdict = document.createElement("div");
  verdict.className = `trace-verdict ${report.passed ? "pass" : "fail"}`;
  verdict.textContent = report.passed ? `Tester PASS · ${event.title}` : `Tester FAIL · ${event.title}`;
  container.append(verdict);
  const summary = detailSection(container, "验收结论");
  detailPre(summary, event.response || (report.passed ? "教师 TB 通过。" : "教师 TB 未通过。"));
  const checks = report.checks || [];
  if (checks.length) {
    const section = detailSection(container, "失败检查");
    checks.slice(0, 8).forEach((check) => {
      const row = document.createElement("div");
      row.className = "trace-check";
      const name = document.createElement("strong");
      name.textContent = check.name || "check";
      const detail = document.createElement("span");
      detail.textContent = check.detail || "";
      row.append(name, detail);
      section.append(row);
    });
  }
  const metrics = report.metrics || {};
  const overview = detailSection(container, "Metric 概览");
  detailPre(
    overview,
    [
      metrics.area !== undefined ? `Area: ${Number(metrics.area).toFixed(3)} ${metrics.area_unit || ""}` : "Area: —",
      metrics.power_status === "ok"
        ? `Total power: ${(Number(metrics.total_power_w) * 1e6).toFixed(3)} µW`
        : "Power: —",
    ].join("\n"),
  );
}

function renderCoderDetail(container, event) {
  const section = detailSection(container, "生成结果");
  detailPre(section, event.response || "Coder 暂无说明。");
  if (event.rtl) {
    const code = detailSection(container, "本文件 RTL");
    detailPre(code, event.rtl);
  }
}

function renderModifierDetail(container, event) {
  const parsed = parseEventJson(event) || {};
  const files = parsed.files || [];
  if (files.length) {
    const section = detailSection(container, "修改的文件");
    detailList(section, files.map((file) => file.path || "—"));
  }
  if (parsed.notes) {
    const notes = detailSection(container, "修改说明");
    detailPre(notes, parsed.notes);
  }
  if (!files.length) {
    const section = detailSection(container, "修改结果");
    detailPre(section, event.response || "Modifier 暂无输出。");
  }
}

function renderAgentDetailContent(event) {
  const container = $("#agent-detail-content");
  if (!container) return;
  container.replaceChildren();
  if (!event) {
    container.textContent = "选择一个运行步骤后，将在这里显示详细内容。";
    return;
  }
  if (event.status === "running" && !event.response && state.agent.detailTab !== "prompt") {
    const note = document.createElement("p");
    note.className = "trace-detail-note";
    note.textContent = "该步骤正在执行，完成后会自动刷新。";
    container.append(note);
    return;
  }
  const tab = state.agent.detailTab;
  if (tab === "prompt") {
    const section = detailSection(container, "发送的 Prompt");
    detailPre(section, event.prompt);
    return;
  }
  if (tab === "reasoning") {
    const section = detailSection(container, "思维链");
    detailPre(section, event.reasoning || "该步骤未返回可展示的模型推理文本。");
    return;
  }
  if (tab === "rtl") {
    if (event.rtl) {
      const section = detailSection(container, "RTL / TB 数据");
      detailPre(section, event.rtl);
    } else if (event.report) {
      const section = detailSection(container, "TB 报告");
      detailPre(section, JSON.stringify(event.report, null, 2));
    } else {
      const section = detailSection(container, "RTL / TB 数据");
      detailPre(section, "该步骤没有 RTL 或 TB 数据。");
    }
    return;
  }
  if (event.error) {
    const section = detailSection(container, "执行失败");
    detailPre(section, event.error);
    return;
  }
  if (event.node_id === "parser") return renderParserDetail(container, event);
  if (event.node_id === "planner") return renderPlannerDetail(container, event);
  if (event.node_id === "tester") return renderTesterDetail(container, event);
  if (event.node_id === "coder") return renderCoderDetail(container, event);
  if (event.node_id === "modifier") return renderModifierDetail(container, event);
  const section = detailSection(container, "模型回答 / 工具输出");
  detailPre(section, event.response || (event.report ? JSON.stringify(event.report, null, 2) : "该步骤没有输出。"));
}

function renderAgentEventDetail() {
  const event = selectedEvent();
  renderAgentDetailContent(event);
  $$(".agent-detail-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.agentDetail === state.agent.detailTab);
  });

  const meta = $("#agent-event-meta");
  meta.replaceChildren();
  if (!event) {
    meta.classList.add("hidden");
  } else {
    meta.classList.remove("hidden");
    const status = eventStatus(event);
    const [label, badge] = statusMeta(status);
    const items = [
      ["STEP", `${event.step}`],
      ["TYPE", event.node_type.toUpperCase()],
      ["STATUS", label, badge],
      ["ATTEMPT", `${event.attempt || 1}`],
      ["DURATION", formatDuration(event.duration_ms)],
    ];
    if (event.usage) items.push(["TOKENS", formatTokens(event.usage)]);
    items.forEach(([key, value, tone]) => {
      const chip = document.createElement("span");
      chip.className = `meta-chip ${tone || ""}`;
      chip.innerHTML = `<b>${escapeHtml(key)}</b><span>${escapeHtml(value)}</span>`;
      meta.append(chip);
    });
    if (event.retry) {
      const chip = document.createElement("span");
      chip.className = `meta-chip retry ${event.retry.exhausted ? "fail" : "running"}`;
      chip.innerHTML = `<b>RETRY</b><span>${event.retry.exhausted ? "次数耗尽" : `回到模型 · 第 ${event.retry.attempt} 轮`}</span>`;
      meta.append(chip);
    }
  }

  const visual = $("#agent-verify-visual");
  if (event?.report) {
    visual.classList.remove("hidden");
    renderAgentVerifyVisual(event.report);
  } else {
    visual.classList.add("hidden");
  }
}

function metricCard(label, value, note, tone = "") {
  const card = document.createElement("div");
  card.className = `metric ${tone}`;
  const title = document.createElement("span");
  title.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  const small = document.createElement("small");
  small.textContent = note;
  card.append(title, strong, small);
  return card;
}

function renderAgentVerifyVisual(report) {
  const metrics = report.metrics || {};
  const container = $("#agent-metrics");
  container.replaceChildren();
  if (metrics.area !== undefined) {
    container.append(metricCard("Area", Number(metrics.area).toFixed(3), metrics.area_unit || "library area units", "accent"));
  } else {
    container.append(metricCard("Area", "—", metrics.reason || "综合未完成"));
  }
  if (metrics.power_status === "ok") {
    container.append(metricCard("Total power", `${(Number(metrics.total_power_w) * 1e6).toFixed(3)} µW`, `动态 ${(Number(metrics.dynamic_power_w) * 1e6).toFixed(3)} µW`));
  } else {
    container.append(metricCard("Power", "—", metrics.power_reason || "需要活动信息"));
  }
  const stage = report.stage === "compile" ? "COMPILE" : "SIMULATION";
  container.append(metricCard("Result", report.passed ? "PASS" : "FAIL", stage, report.passed ? "success" : "failure"));
  renderAgentTrace(report);
  $("#agent-tb-stdout").textContent = [report.stdout, report.stderr].filter(Boolean).join("\n") || "—";
}

function traceColumns(trace) {
  const first = trace[0] || {};
  if ("signal" in first || "pulse" in first || "expected_pulse" in first) {
    return [
      { key: "cycle", label: "Cycle" },
      { key: "event", label: "场景 / 事件" },
      { key: "signal", label: "signal" },
      { key: "pulse", label: "pulse" },
      { key: "expected_pulse", label: "期望" },
    ];
  }
  const keys = [];
  Object.keys(first).forEach((key) => {
    if (!key.startsWith("expected_") && keys.length < 7) keys.push(key);
  });
  return keys.map((key) => ({ key, label: key }));
}

function traceRowMismatch(row) {
  return Object.entries(row).some(([key, value]) => {
    if (!key.startsWith("expected_")) return false;
    const actual = row[key.slice("expected_".length)];
    return actual !== undefined && String(actual) !== String(value);
  });
}

function renderAgentTrace(report) {
  const wrap = $("#agent-trace-wrap");
  const trace = report.trace || [];
  if (!trace.length) {
    wrap.className = "trace-wrap empty-copy";
    wrap.textContent = "该次验证未产生可视化 trace；编译失败时请查看原始 TB 输出。";
    return;
  }
  const columns = traceColumns(trace);
  const table = document.createElement("table");
  table.className = "trace-table agent-trace-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column.label;
    headRow.append(th);
  });
  head.append(headRow);
  const body = document.createElement("tbody");
  trace.forEach((row) => {
    const tr = document.createElement("tr");
    if (traceRowMismatch(row)) tr.className = "mismatch";
    columns.forEach((column) => {
      const td = document.createElement("td");
      const value = row[column.key];
      if (column.key === "pulse" && row.expected_pulse !== undefined) {
        const span = document.createElement("span");
        span.className = String(value) === String(row.expected_pulse) ? "signal-high" : "signal-mismatch";
        span.textContent = value ?? "—";
        td.append(span);
      } else {
        td.textContent = value ?? "—";
      }
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(head, body);
  wrap.className = "trace-wrap";
  wrap.replaceChildren(table);
}

/* ------------------------------ Design space ------------------------------ */

async function loadAgentDesigns() {
  try {
    const payload = await api("/api/agent/designs");
    state.agent.designs = payload.designs || [];
    renderAgentDesigns();
  } catch (error) {
    showToast(`无法读取设计空间：${error.message}`, "error");
  }
}

function renderAgentDesigns() {
  const list = $("#agent-design-list");
  const designs = state.agent.designs || [];
  $("#agent-design-count").textContent = `${designs.length}`;
  list.replaceChildren();
  if (!designs.length) {
    list.className = "design-list empty-copy";
    list.textContent = "尚无保存的设计";
    return;
  }
  list.className = "design-list";
  designs.forEach((design) => {
    const item = document.createElement("div");
    item.className = `design-item ${design.id === state.agent.designId ? "current" : ""}`;
    const main = document.createElement("button");
    main.type = "button";
    main.className = "design-item-main";
    main.title = design.description || design.name;
    const name = document.createElement("span");
    name.className = "design-item-name";
    name.textContent = design.name;
    const meta = document.createElement("span");
    meta.className = "design-item-meta";
    meta.textContent = `${design.node_count} nodes · ${design.retry_count} retry · ${formatClock(design.updated_at)}`;
    main.append(name, meta);
    main.addEventListener("click", () => loadAgentDesign(design.id));

    const actions = document.createElement("div");
    actions.className = "design-item-actions";
    const load = document.createElement("button");
    load.type = "button";
    load.className = "design-load-button";
    load.textContent = "载入";
    load.addEventListener("click", () => loadAgentDesign(design.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "design-delete-button";
    remove.textContent = "删除";
    remove.addEventListener("click", () => deleteAgentDesign(design.id));
    actions.append(load, remove);
    item.append(main, actions);
    list.append(item);
  });
}

async function saveAgentDesign() {
  if (state.agent.running) {
    showToast("Agent 运行中，请完成后再保存设计", "warning");
    return;
  }
  const name = $("#agent-design-name").value.trim();
  if (!name) {
    showToast("请先为当前设计命名", "warning");
    $("#agent-design-name").focus();
    return;
  }
  const button = $("#agent-design-save");
  button.disabled = true;
  try {
    const record = await api("/api/agent/designs", {
      method: "POST",
      body: JSON.stringify({ name, graph: agentGraph() }),
    });
    state.agent.graph = record.graph;
    setCurrentDesign(record);
    renderAgentCanvas();
    $("#agent-design-name").value = "";
    await loadAgentDesigns();
    showToast(`已保存设计「${record.name}」`, "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadAgentDesign(designId) {
  if (state.agent.running) {
    showToast("Agent 运行中，请等待完成或先停止后再载入设计", "warning");
    return;
  }
  const approved = await confirmAction(
    "载入设计",
    "载入会替换当前画布，未保存的修改将丢失。可以用撤销恢复替换前的图。",
    "载入"
  );
  if (!approved) return;
  try {
    const design = await api(`/api/agent/designs/${designId}`);
    const snapshot = graphSnapshot();
    state.agent.graph = normalizeAgentGraph(design.graph);
    state.agent.selectedNodeId = null;
    clearAgentInspector();
    setCurrentDesign(design);
    pushHistorySnapshot(snapshot);
    renderAgentCanvas();
    fitAgentView();
    scheduleAgentSave();
    await loadAgentDesigns();
    showToast(`已载入设计「${design.name}」`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteAgentDesign(designId) {
  const design = state.agent.designs.find((item) => item.id === designId);
  const approved = await confirmAction(
    "删除设计",
    `删除设计「${design?.name || designId}」？已保存的运行记录不会受影响。`,
    "删除"
  );
  if (!approved) return;
  try {
    await api(`/api/agent/designs/${designId}`, { method: "DELETE" });
    if (state.agent.designId === designId) setCurrentDesign(null);
    await loadAgentDesigns();
    showToast("设计已删除", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderCompareScatter(runs) {
  const wrap = document.createElement("div");
  wrap.className = "compare-scatter";
  const points = runs
    .map((run) => ({
      run,
      area: run.area === null || run.area === undefined ? NaN : Number(run.area),
      power: run.total_power_w === null || run.total_power_w === undefined ? NaN : Number(run.total_power_w) * 1e6,
    }))
    .filter((point) => Number.isFinite(point.area) && Number.isFinite(point.power) && point.area >= 0 && point.power >= 0);
  if (!points.length) {
    wrap.classList.add("empty");
    wrap.textContent = "至少需要一次包含面积与功耗的运行，才能绘制 PPA 散点。";
    return wrap;
  }
  const width = 720;
  const height = 210;
  const padding = { left: 58, right: 24, top: 18, bottom: 34 };
  const areas = points.map((point) => point.area);
  const powers = points.map((point) => point.power);
  let minArea = Math.min(...areas);
  let maxArea = Math.max(...areas);
  let minPower = Math.min(...powers);
  let maxPower = Math.max(...powers);
  const areaSpan = Math.max(maxArea - minArea, maxArea * 0.08, 0.1);
  const powerSpan = Math.max(maxPower - minPower, maxPower * 0.08, 0.1);
  minArea = Math.max(0, minArea - areaSpan * 0.15);
  maxArea += areaSpan * 0.15;
  minPower = Math.max(0, minPower - powerSpan * 0.15);
  maxPower += powerSpan * 0.15;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (value) => padding.left + ((value - minArea) / (maxArea - minArea || 1)) * plotWidth;
  const y = (value) => padding.top + plotHeight - ((value - minPower) / (maxPower - minPower || 1)) * plotHeight;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "scatter-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "面积与功耗的设计空间散点图");

  [0, 0.25, 0.5, 0.75, 1].forEach((fraction) => {
    const gridY = padding.top + plotHeight * fraction;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(padding.left));
    line.setAttribute("x2", String(width - padding.right));
    line.setAttribute("y1", String(gridY));
    line.setAttribute("y2", String(gridY));
    line.setAttribute("class", "scatter-grid");
    svg.append(line);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(padding.left - 8));
    label.setAttribute("y", String(gridY + 3));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "scatter-label");
    label.textContent = (maxPower - (maxPower - minPower) * fraction).toFixed(2);
    svg.append(label);
  });
  const axis = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axis.setAttribute("x1", String(padding.left));
  axis.setAttribute("x2", String(width - padding.right));
  axis.setAttribute("y1", String(height - padding.bottom));
  axis.setAttribute("y2", String(height - padding.bottom));
  axis.setAttribute("class", "scatter-axis");
  svg.append(axis);

  const xLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  xLabel.setAttribute("x", String(width - padding.right));
  xLabel.setAttribute("y", String(height - 10));
  xLabel.setAttribute("text-anchor", "end");
  xLabel.setAttribute("class", "scatter-axis-label");
  xLabel.textContent = "Area";
  svg.append(xLabel);
  const yLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  yLabel.setAttribute("x", "12");
  yLabel.setAttribute("y", String(padding.top + 2));
  yLabel.setAttribute("class", "scatter-axis-label");
  yLabel.textContent = "Power (µW)";
  svg.append(yLabel);

  points.forEach((point) => {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(x(point.area)));
    circle.setAttribute("cy", String(y(point.power)));
    circle.setAttribute("r", "6");
    circle.setAttribute("class", `scatter-point ${point.run.status === "passed" ? "pass" : "fail"}`);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${point.run.design_name || "临时图"} · ${point.run.status.toUpperCase()}
Area ${point.area.toFixed(3)} · Power ${point.power.toFixed(3)} µW
${point.run.run_id}`;
    circle.append(title);
    circle.addEventListener("click", () => loadAgentRun(point.run.run_id));
    svg.append(circle);
  });
  wrap.append(svg);
  return wrap;
}

function renderAgentComparison(runs) {
  state.agent.runs = runs || [];
  const body = $("#agent-compare-body");
  const summary = $("#agent-compare-summary");
  body.replaceChildren();
  if (!state.agent.runs.length) {
    summary.textContent = "尚无运行记录";
    body.className = "agent-compare-body empty-copy";
    body.textContent = "运行 Agent 后，将在这里比较不同设计的通过情况、轮次、耗时、token 与电路 metric。";
    return;
  }

  const passed = state.agent.runs.filter((run) => run.status === "passed").length;
  const failed = state.agent.runs.filter((run) => run.status === "failed").length;
  const durations = state.agent.runs.map((run) => run.duration_ms).filter((value) => Number.isFinite(value));
  const tokenRuns = state.agent.runs.map((run) => run.total_tokens).filter((value) => Number(value) > 0);
  const average = (values) => values.length ? values.reduce((total, value) => total + Number(value), 0) / values.length : null;
  const averageDuration = average(durations);
  const averageTokens = average(tokenRuns);
  summary.textContent = `${state.agent.runs.length} runs · ${passed} pass · ${failed} fail`;

  const chips = document.createElement("div");
  chips.className = "compare-summary";
  [
    ["RUNS", `${state.agent.runs.length}`, ""],
    ["PASS", `${passed}`, "pass"],
    ["FAIL", `${failed}`, "fail"],
    ["AVG TIME", averageDuration === null ? "—" : formatDuration(averageDuration), ""],
    ["AVG TOKENS", averageTokens === null ? "—" : `${Math.round(averageTokens)} tok`, ""],
  ].forEach(([label, value, tone]) => {
    const chip = document.createElement("span");
    chip.className = `compare-chip ${tone}`;
    const strong = document.createElement("b");
    strong.textContent = label;
    chip.append(strong, document.createTextNode(value));
    chips.append(chip);
  });
  body.append(chips);
  body.append(renderCompareScatter(state.agent.runs));

  const wrap = document.createElement("div");
  wrap.className = "compare-table-wrap";
  const table = document.createElement("table");
  table.className = "compare-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["运行", "结果", "轮次", "步数", "耗时", "Tokens", "Area", "Power", "开始"].forEach((label, index) => {
    const th = document.createElement("th");
    th.textContent = label;
    if (index >= 2 && index <= 7) th.className = "compare-num";
    headRow.append(th);
  });
  head.append(headRow);
  const tbody = document.createElement("tbody");
  state.agent.runs.forEach((run) => {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.title = `载入 ${run.run_id}`;
    if (state.agent.run?.run_id === run.run_id) tr.classList.add("active");
    const addCell = (text, className = "") => {
      const td = document.createElement("td");
      td.textContent = text;
      if (className) td.className = className;
      tr.append(td);
      return td;
    };
    addCell(run.run_id.replace(/^agent-/, ""), "compare-design");
    const statusCell = document.createElement("td");
    const [label, tone] = statusMeta(run.status);
    const badge = document.createElement("span");
    badge.className = `compare-status ${tone}`;
    badge.textContent = label;
    statusCell.append(badge);
    tr.append(statusCell);
    addCell(`${run.attempts ?? 1}`, "compare-num");
    addCell(`${run.event_count ?? "—"}`, "compare-num");
    addCell(formatDuration(run.duration_ms), "compare-num");
    addCell(run.total_tokens ? `${run.total_tokens}` : "—", "compare-num");
    addCell(run.area !== null && run.area !== undefined ? Number(run.area).toFixed(3) : "—", "compare-num");
    addCell(run.total_power_w !== null && run.total_power_w !== undefined ? `${(Number(run.total_power_w) * 1e6).toFixed(3)} µW` : "—", "compare-num");
    addCell(formatClock(run.started_at));
    const load = () => loadAgentRun(run.run_id);
    tr.addEventListener("click", load);
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        load();
      }
    });
    tbody.append(tr);
  });
  table.append(head, tbody);
  wrap.append(table);
  body.className = "agent-compare-body";
  body.append(wrap);
}

/* ------------------------------- Agent runs ------------------------------- */

function setAgentRunningUi(running) {
  $("#agent-view").classList.toggle("running", running);
  $("#agent-run-button").disabled = running;
  $("#agent-stop-button").classList.toggle("hidden", !running);
  $("#agent-stop-button").disabled = state.agent.cancelling;
  $("#agent-progress").classList.toggle("hidden", !running);
  $("#agent-progress").classList.toggle("indeterminate", running);
}

function startRunTimer() {
  clearInterval(state.agent.runTimer);
  state.agent.runStartedAt = Date.now();
  state.agent.runTimer = setInterval(() => {
    if (!state.agent.running) return;
    if (state.agent.job?.status === "waiting_input") return;
    const elapsed = formatDuration(Date.now() - state.agent.runStartedAt);
    $("#agent-run-status").textContent = state.agent.cancelling
      ? `正在停止… · ${elapsed}`
      : `运行中 · ${state.agent.events.length} 步 · ${elapsed}`;
    $("#agent-run-status").className = "muted running";
  }, 1000);
}

function stopRunTimer() {
  clearInterval(state.agent.runTimer);
  state.agent.runTimer = null;
}

function updateAgentRunStatus(job) {
  const status = job?.status || (state.agent.run?.status ?? "ready");
  const level = job?.error ? "error" : ["running", "cancelling", "waiting_input"].includes(status) ? "running" : "";
  if (status === "waiting_input") {
    $("#agent-run-status").textContent = "等待用户补充 Spec…";
    $("#agent-run-status").className = "muted running";
    return;
  }
  if (status === "running" || status === "cancelling") {
    const elapsed = state.agent.runStartedAt ? formatDuration(Date.now() - state.agent.runStartedAt) : "0 ms";
    $("#agent-run-status").textContent = status === "cancelling"
      ? `正在停止… · ${elapsed}`
      : `运行中 · ${state.agent.events.length} 步 · ${elapsed}`;
  } else if (job?.error) {
    const [label] = statusMeta(job.status);
    $("#agent-run-status").textContent = state.agent.run
      ? `${label} · ${state.agent.run.run_id} · ${formatDuration(state.agent.run.duration_ms)}`
      : `${label} · ${job.error}`;
    $("#agent-run-status").title = job.error;
  } else if (state.agent.run) {
    const result = state.agent.run;
    const [label] = statusMeta(result.status);
    const tokens = totalTokens(result.events);
    $("#agent-run-status").textContent = `${label} · ${result.run_id} · ${formatDuration(result.duration_ms)}${tokens ? ` · ${tokens} tok` : ""}`;
  } else {
    $("#agent-run-status").textContent = "固定流程就绪，点击 Run Agent 运行";
  }
  $("#agent-run-status").className = `muted ${level}`;
}

async function saveAgentGraph() {
  const graph = agentGraph();
  if (!graph) return null;
  localStorage.setItem("ai-eda-agent-graph-draft", JSON.stringify(graph));
  setAgentSaveStatus("正在保存…", "saving");
  try {
    const saved = await api("/api/agent/graph", { method: "PUT", body: JSON.stringify(graph) });
    state.agent.serverGraph = saved;
    localStorage.removeItem("ai-eda-agent-graph-draft");
    setAgentSaveStatus("流程已保存", "saved");
    return saved;
  } catch (error) {
    setAgentSaveStatus("保存失败，浏览器保留草稿", "error");
    showToast(error.message, "error");
    throw error;
  }
}

function scheduleAgentSave() {
  if (!agentGraph()) return;
  localStorage.setItem("ai-eda-agent-graph-draft", JSON.stringify(agentGraph()));
  setAgentSaveStatus("浏览器草稿已保存", "saving");
  clearTimeout(state.agent.saveTimer);
  state.agent.saveTimer = setTimeout(() => saveAgentGraph().catch(() => {}), 700);
}

async function runAgent() {
  if (!agentGraph() || state.agent.running) return;
  state.agent.running = true;
  state.agent.cancelling = false;
  state.agent.job = null;
  state.agent.run = null;
  state.agent.events = [];
  state.agent.selectedStep = null;
  state.agent.followLive = true;
  closeAgentInputDialog();
  renderAgentResult(null);
  updateFollowLiveButton();
  setAgentRunningUi(true);
  startRunTimer();
  $("#agent-run-status").textContent = "正在启动 Agent 作业…";
  $("#agent-run-status").className = "muted running";
  renderAgentCanvas();
  renderAgentEvents();
  try {
    const job = await api("/api/agent/jobs", {
      method: "POST",
      body: JSON.stringify({
        thinking: $("#agent-thinking").checked,
        temperature: Number($("#agent-temperature").value),
        max_tokens: Number($("#agent-max-tokens").value),
        reasoning_effort: $("#agent-reasoning-effort").value,
      }),
    });
    state.agent.job = { job_id: job.job_id, status: "running", events: [], result: null, error: null };
    pollAgentJob(job.job_id, 0);
  } catch (error) {
    state.agent.running = false;
    stopRunTimer();
    setAgentRunningUi(false);
    $("#agent-run-status").textContent = error.message;
    $("#agent-run-status").className = "muted error";
    showToast(error.message, "error");
  }
}

async function pollAgentJob(jobId, attempt = 0) {
  if (!state.agent.running) return;
  try {
    const job = await api(`/api/agent/jobs/${jobId}`);
    if (!state.agent.job || state.agent.job.job_id !== jobId) return;
    state.agent.job = job;
    state.agent.events = job.result?.events?.length ? job.result.events : (job.events || []);
    if (state.agent.followLive && state.agent.events.length) {
      state.agent.selectedStep = state.agent.events[state.agent.events.length - 1].step;
    }
    renderAgentCanvas();
    renderAgentEvents();
    updateAgentRunStatus(job);
    if (job.status === "waiting_input") {
      showAgentInputDialog(job.input_request);
      return;
    }
    if (["running", "cancelling"].includes(job.status)) {
      clearTimeout(state.agent.pollTimer);
      state.agent.pollTimer = setTimeout(() => pollAgentJob(jobId), 500);
    } else {
      finishAgentJob(job);
    }
  } catch (error) {
    if (attempt < 3) {
      clearTimeout(state.agent.pollTimer);
      state.agent.pollTimer = setTimeout(() => pollAgentJob(jobId, attempt + 1), 800 * (attempt + 1));
      return;
    }
    state.agent.running = false;
    stopRunTimer();
    setAgentRunningUi(false);
    $("#agent-run-status").textContent = `无法获取 Agent 作业状态：${error.message}`;
    $("#agent-run-status").className = "muted error";
    showToast(`无法获取 Agent 作业状态：${error.message}`, "error");
  }
}

function closeAgentInputDialog() {
  const dialog = $("#agent-input-dialog");
  if (dialog?.open) dialog.close();
  state.agent.waitingInput = null;
}

function showAgentInputDialog(request) {
  if (!request) return;
  state.agent.waitingInput = request;
  const dialog = $("#agent-input-dialog");
  if (!dialog || dialog.open) return;
  $("#agent-input-summary").textContent = request.prompt || "Parser 判断 Spec 需要补充以下信息。";
  const list = $("#agent-input-questions");
  list.replaceChildren();
  [...(request.missing || []), ...(request.questions || [])].forEach((item) => {
    const li = document.createElement("li");
    li.textContent = String(item);
    list.append(li);
  });
  $("#agent-input-response").value = "";
  $("#agent-input-status").textContent = "";
  dialog.showModal();
  setTimeout(() => $("#agent-input-response").focus(), 50);
}

async function submitAgentInput(event) {
  event.preventDefault();
  const job = state.agent.job;
  const response = $("#agent-input-response").value.trim();
  if (!job || !response) {
    $("#agent-input-status").textContent = "请填写补充内容";
    return;
  }
  $("#agent-input-submit").disabled = true;
  $("#agent-input-status").textContent = "正在提交…";
  try {
    await api(`/api/agent/jobs/${job.job_id}/input`, {
      method: "POST",
      body: JSON.stringify({ response }),
    });
    closeAgentInputDialog();
    updateAgentRunStatus({ status: "running" });
    pollAgentJob(job.job_id);
  } catch (error) {
    $("#agent-input-status").textContent = error.message;
  } finally {
    $("#agent-input-submit").disabled = false;
  }
}

async function cancelAgentInput() {
  closeAgentInputDialog();
  await cancelAgentRun();
  const job = state.agent.job;
  if (job) pollAgentJob(job.job_id);
}

function finishAgentJob(job) {
  closeAgentInputDialog();
  state.agent.running = false;
  state.agent.cancelling = false;
  stopRunTimer();
  setAgentRunningUi(false);
  if (job.result) {
    state.agent.run = job.result;
    state.agent.events = job.result.events || state.agent.events;
    state.agent.selectedStep = pickEventForResult(job.result);
  } else {
    state.agent.run = null;
    state.agent.events = job.events || state.agent.events;
    state.agent.selectedStep = state.agent.events[state.agent.events.length - 1]?.step ?? null;
  }
  state.agent.followLive = false;
  updateFollowLiveButton();
  updateAgentRunStatus(job);
  renderAgentResult(job.result?.result || null);
  renderAgentCanvas();
  renderAgentEvents();
  loadAgentRuns().catch(() => {});
  const status = job.result?.status || job.status;
  if (job.status === "failed") showToast(job.error || "Agent 运行失败", "error");
  else if (job.status === "cancelled") showToast("Agent 运行已取消", "warning");
  else if (status === "passed") showToast(`Agent 运行完成：TB PASS（${formatDuration(job.result?.duration_ms)}）`, "success");
  else if (status === "failed") showToast("Agent 运行完成，但教师 TB 未通过", "error");
  else showToast("Agent 运行完成", "success");
}

function pickEventForResult(result) {
  const events = result.events || [];
  if (result.status === "failed") {
    const failed = [...events].reverse().find((event) => event.report && !event.report.passed);
    if (failed) return failed.step;
  }
  const verify = [...events].reverse().find((event) => event.report);
  return verify?.step ?? events[events.length - 1]?.step ?? null;
}

async function cancelAgentRun() {
  if (!state.agent.running || state.agent.cancelling || !state.agent.job) return;
  state.agent.cancelling = true;
  $("#agent-stop-button").disabled = true;
  $("#agent-run-status").textContent = "正在停止…";
  $("#agent-run-status").className = "muted running";
  try {
    await api(`/api/agent/jobs/${state.agent.job.job_id}/cancel`, { method: "POST", body: "{}" });
    showToast("已请求停止；当前模型调用结束后生效", "warning");
  } catch (error) {
    state.agent.cancelling = false;
    $("#agent-stop-button").disabled = false;
    showToast(error.message, "error");
  }
}

async function loadAgentRuns() {
  const payload = await api("/api/agent/runs");
  renderAgentComparison(payload.runs || []);
  const list = $("#agent-run-list");
  list.replaceChildren();
  if (!payload.runs.length) {
    list.className = "run-list empty-copy";
    list.textContent = "尚无 Agent 运行记录";
    return;
  }
  list.className = "run-list agent-run-list";
  payload.runs.forEach((run) => {
    const [label, tone] = statusMeta(run.status);
    const item = document.createElement("div");
    item.className = "run-item agent-run-item";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "run-open-button";
    open.innerHTML = `
      <span class="run-item-title"><strong>${escapeHtml(run.run_id.replace(/^agent-/, ""))}</strong><span class="mini-badge ${tone}">${label}</span></span>
      <span>${escapeHtml(formatClock(run.started_at))} · ${formatDuration(run.duration_ms)} · ${run.event_count} steps${run.attempts > 1 ? ` · ${run.attempts} 轮` : ""}${run.total_tokens ? ` · ${run.total_tokens} tok` : ""}</span>
    `;
    open.addEventListener("click", () => loadAgentRun(run.run_id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "run-delete-button";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", `删除 Agent 运行 ${run.run_id}`);
    remove.addEventListener("click", () => deleteAgentRun(run.run_id));
    item.append(open, remove);
    list.append(item);
  });
}

async function loadAgentRun(runId) {
  if (state.agent.running) {
    showToast("Agent 运行中，请等待完成或先停止后再载入历史", "warning");
    return;
  }
  try {
    const payload = await api(`/api/agent/runs/${runId}`);
    state.agent.running = false;
    state.agent.cancelling = false;
    state.agent.job = null;
    state.agent.run = payload;
    state.agent.events = payload.events || [];
    state.agent.selectedStep = pickEventForResult(payload);
    state.agent.followLive = false;
    updateFollowLiveButton();
    stopRunTimer();
    setAgentRunningUi(false);
    $("#agent-progress").classList.add("hidden");
    updateAgentRunStatus({ status: payload.status });
    renderAgentResult(payload.result || null);
    renderAgentCanvas();
    renderAgentEvents();
    renderAgentComparison(state.agent.runs);
    showToast(`已载入运行 ${runId}`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteAgentRun(runId) {
  const approved = await confirmAction("删除 Agent 运行记录", `删除“${runId}”？此操作不可恢复。`, "删除");
  if (!approved) return;
  try {
    await api(`/api/agent/runs/${runId}`, { method: "DELETE" });
    if (state.agent.run?.run_id === runId) {
      state.agent.run = null;
      state.agent.events = [];
      state.agent.selectedStep = null;
      renderAgentResult(null);
      renderAgentCanvas();
      renderAgentEvents();
      updateAgentRunStatus(null);
    }
    await loadAgentRuns();
    showToast(`已删除 ${runId}`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function clearAgentRuns() {
  const approved = await confirmAction("清空 Agent 运行记录", "清空全部 Agent 运行记录？此操作不可恢复。", "清空");
  if (!approved) return;
  try {
    const result = await api("/api/agent/runs", { method: "DELETE" });
    state.agent.run = null;
    state.agent.events = [];
    state.agent.selectedStep = null;
    renderAgentResult(null);
    renderAgentCanvas();
    renderAgentEvents();
    updateAgentRunStatus(null);
    await loadAgentRuns();
    showToast(`已清空 ${result.deleted} 条 Agent 运行记录`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function loadAgentGraph() {
  const [server, agentState] = await Promise.all([
    api("/api/agent/graph"),
    api("/api/agent/state"),
  ]);
  state.agent.spec = agentState.spec || "";
  state.agent.catalog = agentState.catalog || { builtin: [], skills: [] };
  state.agent.skills = agentState.skills || [];
  renderAgentSkills();
  state.agent.serverGraph = normalizeAgentGraph(server);
  state.agent.graph = JSON.parse(JSON.stringify(state.agent.serverGraph));
  state.agent.needsFit = true;
  renderAgentCanvas();
  updateFollowLiveButton();
  requestAnimationFrame(() => {
    if (!$("#agent-view").classList.contains("hidden")) fitAgentView();
  });
}

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
  const answerNode = document.createElement("pre");
  answerNode.className = "param-answer";
  answerNode.textContent = answer || "（模型没有返回可展示的内容）";
  card.append(answerNode);
  if (reasoning) {
    const details = document.createElement("details");
    details.className = "param-reasoning";
    const summary = document.createElement("summary");
    summary.textContent = `思维链（${reasoning.length} 字）`;
    const reasoningNode = document.createElement("pre");
    reasoningNode.textContent = reasoning;
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

/* ------------------------------- Homework tab ------------------------------- */

const HOMEWORK_DRAFT_KEY = "ai-eda-homework-draft";

function setHomeworkSaveStatus(text, mode = "") {
  const node = $("#hw-save-status");
  if (!node) return;
  node.textContent = text;
  node.className = `save-status ${mode}`;
}

function setHomeworkStatus(text, mode = "") {
  const node = $("#hw-run-status");
  if (!node) return;
  node.textContent = text;
  node.className = `run-status ${mode}`;
}

function renderHomeworkResponse() {
  const content = $("#hw-response-content");
  if (!content) return;
  content.replaceChildren();
  $$("[data-hw-response-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.hwResponseTab === state.homework.activeResponseTab);
  });
  const run = state.homework.lastRun;
  if (!run) {
    content.className = "response-content empty-copy";
    content.textContent = "运行后将在这里显示模型回答；可在顶部切换查看提取出的 RTL。";
    return;
  }
  content.className = "response-content";
  if (state.homework.activeResponseTab === "rtl") {
    const body = document.createElement("pre");
    body.className = "response-block-body response-rtl";
    body.textContent = run.rtl || "未能从模型回答中提取 RTL。";
    content.append(body);
    return;
  }
  content.append(
    responseBlock(
      "思维链",
      "reasoning",
      run.reasoning,
      "该次调用未返回可展示的推理文本。可勾选“请求模型思考文本”后重新运行；RTL 是否正确仍以教师 TB 为准。",
    ),
    responseBlock("最终回答", "answer", run.answer, "模型未返回最终回答。"),
  );
  content.scrollTop = 0;
}

function renderHomeworkTrace(trace = []) {
  const wrap = $("#hw-trace-wrap");
  if (!wrap) return;
  if (!trace.length) {
    wrap.className = "trace-wrap empty-copy";
    wrap.textContent = "该次运行未产生结构化 trace；编译失败时请查看原始 TB 输出。";
    return;
  }
  const table = document.createElement("table");
  table.className = "trace-table homework-trace";
  const headRow = document.createElement("tr");
  ["Cycle", "测试", "事件", "结果", "详情"].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  });
  const thead = document.createElement("thead");
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  trace.forEach((event) => {
    const row = document.createElement("tr");
    const cycle = document.createElement("td");
    cycle.textContent = event.cycle ?? "—";
    const test = document.createElement("td");
    test.textContent = event.test || "—";
    const eventName = document.createElement("td");
    eventName.textContent = event.event || "—";
    const result = document.createElement("td");
    const badge = document.createElement("span");
    const ok = String(event.ok) === "1";
    badge.className = `event-result ${ok ? "pass" : "fail"}`;
    badge.textContent = ok ? "OK" : "FAIL";
    result.append(badge);
    const detail = document.createElement("td");
    detail.textContent = event.detail || "—";
    row.append(cycle, test, eventName, result, detail);
    tbody.append(row);
  });
  table.append(thead, tbody);
  wrap.className = "trace-wrap";
  wrap.replaceChildren(table);
}

function renderHomeworkReport(report = {}) {
  const badge = $("#hw-tb-badge");
  if (!badge) return;
  const passed = report.passed;
  badge.textContent = passed === true ? "PASS" : passed === false ? "FAIL" : "NO RUN";
  badge.className = `result-badge ${passed === true ? "pass" : passed === false ? "fail" : "neutral"}`;
  const checks = report.checks || [];
  const checkText = checks.length ? ` · ${checks.map((item) => item.name).join("、")}` : "";
  $("#hw-tb-summary").textContent = report.stage
    ? `${report.stage === "compile" ? "编译" : "仿真"}${passed ? "通过" : "失败"}${checkText}`
    : "尚无测试结果。";
  $("#hw-tb-stdout").textContent = [report.stdout, report.stderr].filter(Boolean).join("\n") || "—";
  renderHomeworkTrace(report.trace || []);
  const metrics = report.metrics || {};
  if (metrics.area !== undefined) {
    $("#hw-metric-area").textContent = Number(metrics.area).toFixed(3);
    $("#hw-metric-unit").textContent = metrics.area_unit || "library area units";
    if (metrics.power_status === "ok") {
      $("#hw-metric-power").textContent = `${(Number(metrics.total_power_w) * 1e6).toFixed(3)} µW`;
      $("#hw-metric-status").textContent = "POWER READY";
      $("#hw-metric-note").textContent = `动态 ${(Number(metrics.dynamic_power_w) * 1e6).toFixed(3)} µW · 漏电 ${(Number(metrics.leakage_power_w) * 1e6).toFixed(3)} µW`;
    } else {
      $("#hw-metric-power").textContent = "—";
      $("#hw-metric-status").textContent = "AREA ONLY";
      $("#hw-metric-note").textContent = metrics.power_reason || "OpenSTA";
    }
  } else {
    $("#hw-metric-area").textContent = "—";
    $("#hw-metric-unit").textContent = metrics.reason || "仅在仿真后的综合成功时显示";
    $("#hw-metric-power").textContent = "N/A";
    $("#hw-metric-status").textContent = metrics.status ? metrics.status.toUpperCase() : "WAIT";
    $("#hw-metric-note").textContent = "Yosys / OpenSTA";
  }
}

function renderHomeworkRun(run) {
  state.homework.lastRun = run;
  const report = run.report || {};
  $("#hw-run-id-label").textContent = run.run_id;
  renderHomeworkResponse();
  renderHomeworkReport(report);
  if (!report.stage) {
    if (report.metrics) {
      const badge = $("#hw-tb-badge");
      badge.textContent = "NO RUN";
      badge.className = "result-badge neutral";
      $("#hw-tb-summary").textContent = "面积/功耗 metric 已评估；教师 AES TB 尚未运行。点击「运行 TB」开始验收。";
      $("#hw-tb-stdout").textContent = "—";
      const trace = $("#hw-trace-wrap");
      trace.className = "trace-wrap empty-copy";
      trace.textContent = "尚未运行教师 AES TB。";
      setHomeworkStatus(`metric 已评估，待运行 TB：${run.run_id}`);
    } else {
      markHomeworkRunPending();
      setHomeworkStatus(`已生成，待验收：${run.run_id}`);
    }
  } else {
    setHomeworkStatus(`完成：${run.run_id}`);
  }
  updateHomeworkActions();
}

function renderHomeworkRuns(runs = []) {
  state.homework.runs = runs;
  const list = $("#hw-run-list");
  if (!list) return;
  list.replaceChildren();
  if (!runs.length) {
    list.className = "run-list empty-copy";
    list.textContent = "尚无课后作业运行记录";
    return;
  }
  list.className = "run-list";
  runs.slice().reverse().forEach((run) => {
    const item = document.createElement("div");
    item.className = "run-item";
    const open = document.createElement("button");
    open.className = "run-open-button";
    const status = run.passed === true ? "PASS" : run.passed === false ? "FAIL" : "未验收";
    const stage = run.stage ? ` · ${escapeHtml(run.stage)}` : "";
    const preview = run.prompt_preview ? `<span class="run-prompt-preview">${escapeHtml(run.prompt_preview)}</span>` : "";
    open.innerHTML = `${escapeHtml(run.run_id)}<span>${status}${stage}</span>${preview}`;
    open.addEventListener("click", () => openHomeworkRun(run.run_id));
    const remove = document.createElement("button");
    remove.className = "run-delete-button";
    remove.type = "button";
    remove.title = `删除 ${run.run_id}`;
    remove.setAttribute("aria-label", `删除课后作业运行 ${run.run_id}`);
    remove.textContent = "删除";
    remove.addEventListener("click", () => deleteHomeworkRun(run.run_id));
    item.append(open, remove);
    list.append(item);
  });
}

async function loadHomeworkState() {
  try {
    const payload = await api("/api/homework/state");
    state.homework.task = payload.task;
    state.homework.prompt = payload.prompt || "";
    $("#hw-task-title").textContent = payload.task.title;
    $("#hw-spec-content").textContent = payload.task.spec;
    $("#hw-prompt-file").textContent = payload.task.prompt_file;
    const draft = localStorage.getItem(HOMEWORK_DRAFT_KEY);
    $("#hw-prompt-editor").value = draft ?? state.homework.prompt;
    setHomeworkSaveStatus(draft === null ? "已读取本地文件" : "已恢复浏览器草稿", draft === null ? "saved" : "");
    renderHomeworkRuns(payload.runs || []);
  } catch (error) {
    showToast(`无法读取课后作业状态：${error.message}`, "error");
    setHomeworkStatus(`无法读取课后作业状态：${error.message}`, "error");
  }
}

async function loadHomeworkRuns() {
  const payload = await api("/api/homework/runs");
  renderHomeworkRuns(payload.runs || []);
  updateHomeworkActions();
}

async function openHomeworkRun(runId) {
  if (state.streaming.active) {
    showToast("模型正在输出，请等待生成完成后再切换运行记录", "warning");
    return;
  }
  try {
    const run = await api(`/api/homework/runs/${runId}`);
    renderHomeworkRun(run);
    if (run.prompt) {
      $("#hw-prompt-editor").value = run.prompt;
      localStorage.removeItem(HOMEWORK_DRAFT_KEY);
      setHomeworkSaveStatus("已载入该轮 Prompt（尚未保存）");
    }
    setHomeworkStatus(`已载入运行记录及其 Prompt：${runId}`);
    showToast("已载入该轮运行记录与 Prompt", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function clearHomeworkResultView() {
  state.homework.lastRun = null;
  $("#hw-run-id-label").textContent = "尚未运行";
  renderHomeworkResponse();
  renderHomeworkReport({});
  updateHomeworkActions();
}

async function deleteHomeworkRun(runId) {
  const approved = await confirmAction("删除课后作业记录", `删除“${runId}”？此操作不可恢复。`, "删除");
  if (!approved) return;
  try {
    await api(`/api/homework/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (state.homework.lastRun?.run_id === runId) clearHomeworkResultView();
    await loadHomeworkRuns();
    showToast(`已删除 ${runId}`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function clearHomeworkRuns() {
  const approved = await confirmAction("清空课后作业记录", "清空全部课后作业运行记录？此操作不可恢复。", "清空");
  if (!approved) return;
  try {
    await api("/api/homework/runs", { method: "DELETE" });
    clearHomeworkResultView();
    await loadHomeworkRuns();
    showToast("已清空课后作业记录", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveHomeworkPrompt() {
  const content = $("#hw-prompt-editor").value;
  localStorage.setItem(HOMEWORK_DRAFT_KEY, content);
  setHomeworkSaveStatus("正在保存…", "saving");
  try {
    await api("/api/homework/prompt", { method: "PUT", body: JSON.stringify({ content }) });
    state.homework.prompt = content;
    localStorage.removeItem(HOMEWORK_DRAFT_KEY);
    setHomeworkSaveStatus("已保存到本地文件", "saved");
  } catch (error) {
    setHomeworkSaveStatus("保存失败，草稿仍在浏览器", "error");
    throw error;
  }
}

function scheduleHomeworkSave() {
  localStorage.setItem(HOMEWORK_DRAFT_KEY, $("#hw-prompt-editor").value);
  setHomeworkSaveStatus("浏览器草稿已保存", "saving");
  clearTimeout(state.homework.saveTimer);
  state.homework.saveTimer = setTimeout(() => saveHomeworkPrompt().catch(() => {}), 650);
}

async function generateHomework() {
  const button = $("#hw-run-button");
  const content = $("#hw-prompt-editor").value;
  if (content.trim().length < 20) {
    showToast("请先填写一条完整的 Prompt（至少 20 个字符）", "warning");
    $("#hw-prompt-editor").focus();
    return;
  }
  if (state.streaming.active) return;
  button.disabled = true;
  updateHomeworkActions();
  clearTimeout(state.homework.saveTimer);
  beginStreamDisplay("homework");
  $("#hw-run-id-label").textContent = "生成中…";
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!state.streaming.active) return;
    setHomeworkStatus(`正在生成… ${formatDuration(Date.now() - startedAt)}`, "running");
  }, 500);
  setHomeworkStatus("正在请求模型，输出会实时显示…", "running");
  let generated = null;
  try {
    await saveHomeworkPrompt();
    await streamApi("/api/homework/stream", {
      content,
      temperature: Number($("#hw-temperature").value),
      max_tokens: Number($("#hw-max-tokens").value),
      thinking: $("#hw-thinking").checked,
      reasoning_effort: $("#hw-reasoning-effort").value,
    }, (event) => {
      if (event.type === "start") {
        $("#hw-run-id-label").textContent = event.run_id;
      } else if (event.type === "reasoning") {
        appendStreamDelta("reasoning", event.text);
      } else if (event.type === "answer") {
        appendStreamDelta("answer", event.text);
      } else if (event.type === "done") {
        generated = event.run;
      } else if (event.type === "error") {
        throw new Error(event.error);
      }
    });
    endStreamDisplay();
    if (!generated) throw new Error("流式生成没有返回运行记录。");
    renderHomeworkRun(generated);
    setHomeworkStatus("生成完成。确认 RTL 后，可点击 TB 面板的「运行 TB」或 metric 面板的「评估 metric」。");
    await loadHomeworkRuns();
  } catch (error) {
    endStreamDisplay();
    setHomeworkStatus(error.message, "error");
    showToast(error.message, "error");
    if (state.homework.lastRun) {
      renderHomeworkResponse();
    } else {
      const content = $("#hw-response-content");
      content.className = "response-content empty-copy";
      content.textContent = "生成失败；修正参数后重试。";
      $("#hw-run-id-label").textContent = "尚未运行";
    }
  } finally {
    clearInterval(timer);
    button.disabled = false;
    updateHomeworkActions();
  }
}

async function verifyHomeworkMode(mode) {
  if (!state.homework.lastRun?.run_id) {
    showToast("请先生成或载入一条课后作业运行记录", "warning");
    return;
  }
  if (state.verifyingHomework) return;
  const taskId = state.homework.lastRun?.metadata?.task_name || state.homework.task?.id;
  if (!taskId) {
    showToast("无法确定课后任务编号", "error");
    return;
  }
  state.verifyingHomework = true;
  updateHomeworkActions();
  const label = mode === "tb" ? "教师 AES TB" : "面积/功耗 metric";
  const startedAt = Date.now();
  const timer = setInterval(() => {
    setHomeworkStatus(`正在运行${label}… ${formatDuration(Date.now() - startedAt)}`, "running");
  }, 500);
  setHomeworkStatus(`正在运行${label}…`, "running");
  try {
    const run = await api("/api/verify", {
      method: "POST",
      body: JSON.stringify({ task_id: taskId, run_id: state.homework.lastRun.run_id, mode }),
    });
    renderHomeworkRun(run);
    await loadHomeworkRuns();
    showToast(`${label}已更新`, "success");
  } catch (error) {
    setHomeworkStatus(error.message, "error");
    showToast(error.message, "error");
  } finally {
    clearInterval(timer);
    state.verifyingHomework = false;
    updateHomeworkActions();
  }
}

async function runHomeworkTB() {
  await verifyHomeworkMode("tb");
}

async function runHomeworkMetric() {
  await verifyHomeworkMode("metrics");
}

/* ------------------------------- App wiring ------------------------------- */

function activateMainTab(name) {
  state.activeMainTab = name;
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.mainTab === name));
  $("#prompt-view").classList.toggle("hidden", name !== "prompt");
  $("#agent-view").classList.toggle("hidden", name !== "agent");
  $("#params-view").classList.toggle("hidden", name !== "params");
  if (name === "agent") {
    requestAnimationFrame(() => {
      fitAgentView();
      drawAgentEdges();
    });
  }
}

function activatePromptTab(name) {
  state.activePromptTab = name;
  $$("[data-prompt-tab]").forEach((button) => button.classList.toggle("active", button.dataset.promptTab === name));
  $("#teaching-view").classList.toggle("hidden", name !== "teaching");
  $("#homework-view").classList.toggle("hidden", name !== "homework");
}

function bindAgentToolbar() {
  $("#agent-run-button").addEventListener("click", runAgent);
  $("#agent-stop-button").addEventListener("click", cancelAgentRun);
  $("#agent-input-form").addEventListener("submit", submitAgentInput);
  $("#agent-input-cancel").addEventListener("click", cancelAgentInput);
  $("#agent-input-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    showToast("请提交补充内容，或点击停止 Agent", "warning");
  });
  $("#agent-refresh-runs").addEventListener("click", () => loadAgentRuns().catch((error) => showToast(error.message, "error")));
  $("#agent-clear-runs").addEventListener("click", clearAgentRuns);
  $("#agent-copy-detail").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#agent-detail-content").textContent || "");
      showToast("已复制当前内容", "success");
    } catch (_) {
      showToast("无法访问剪贴板", "error");
    }
  });
  $("#agent-follow-live").addEventListener("click", () => {
    state.agent.followLive = true;
    const last = state.agent.events[state.agent.events.length - 1];
    if (last) state.agent.selectedStep = last.step;
    updateFollowLiveButton();
    renderAgentEvents();
    applyExecutionState();
  });
  $$(".agent-detail-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.agent.detailTab = button.dataset.agentDetail;
      renderAgentEventDetail();
    });
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!$("#agent-view").classList.contains("hidden") && agentGraph()) fitAgentView();
    }, 150);
  });
}

function bindGlobalShortcuts() {
  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    const typing = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "s") {
      if (state.activeMainTab === "prompt") {
        event.preventDefault();
        if (state.activePromptTab === "homework") saveHomeworkPrompt().catch(() => {});
        else showToast("教学 Prompt 为只读，由教师在文件中维护", "warning");
      }
      return;
    }
    if (command && event.key === "Enter") {
      if (state.activeMainTab === "agent") {
        event.preventDefault();
        runAgent();
      }
      return;
    }
    if (state.activeMainTab !== "agent" || typing) return;
    if (event.key === "Escape") {
      state.agent.selectedNodeId = null;
      clearAgentInspector();
      applyExecutionState();
    }
  });
}
function bindEvents() {
  $$("[data-main-tab]").forEach((button) => button.addEventListener("click", () => activateMainTab(button.dataset.mainTab)));
  $$("[data-prompt-tab]").forEach((button) => button.addEventListener("click", () => activatePromptTab(button.dataset.promptTab)));
  $$("[data-response-tab]").forEach((button) => button.addEventListener("click", () => {
    if (state.streaming.active) return;
    state.activeResponseTab = button.dataset.responseTab;
    renderResponse();
  }));
  $("#run-button").addEventListener("click", generatePrompt);
  $("#run-tb-button").addEventListener("click", runPromptTB);
  $("#run-metric-button").addEventListener("click", runPromptMetric);
  $("#refresh-runs").addEventListener("click", () => loadRuns().catch(() => {}));
  $("#clear-runs").addEventListener("click", clearRuns);
  $("#hw-prompt-editor").addEventListener("input", scheduleHomeworkSave);
  $("#hw-run-button").addEventListener("click", generateHomework);
  $("#hw-run-tb-button").addEventListener("click", runHomeworkTB);
  $("#hw-run-metric-button").addEventListener("click", runHomeworkMetric);
  $("#hw-refresh-runs").addEventListener("click", () => loadHomeworkRuns().catch((error) => showToast(error.message, "error")));
  $("#hw-clear-runs").addEventListener("click", clearHomeworkRuns);
  $$("[data-hw-response-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.streaming.active) return;
      state.homework.activeResponseTab = button.dataset.hwResponseTab;
      renderHomeworkResponse();
    });
  });
  const warnThinkingBudget = (checkbox, maxTokensInput) => {
    if (!checkbox || !maxTokensInput) return;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && Number(maxTokensInput.value) < 8192) {
        showToast("思考模式会消耗较多输出预算；若出现空回答，请把 Max tokens 调到 8192 以上，或在只要 RTL 时关闭思考", "warning");
      }
    });
  };
  warnThinkingBudget($("#thinking"), $("#max-tokens"));
  warnThinkingBudget($("#agent-thinking"), $("#agent-max-tokens"));
  warnThinkingBudget($("#hw-thinking"), $("#hw-max-tokens"));
  $("#params-demos").addEventListener("click", (event) => {
    const button = event.target.closest("[data-param-run]");
    if (!button) return;
    const card = button.closest("[data-param-demo]");
    if (card) runParamExperiment(card.dataset.paramDemo, button.dataset.paramRun);
  });
  $("#param-sub-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-param-tab]");
    if (button) activateParamTab(button.dataset.paramTab);
  });
  bindAgentToolbar();
  bindGlobalShortcuts();
}

async function initialize() {
  bindEvents();
  try {
    const payload = await api("/api/state");
    state.task = payload.task;
    payload.task.prompts.forEach((prompt) => state.prompts.set(prompt.id, prompt));
    $("#task-title").textContent = payload.task.title;
    selectPrompt(payload.task.prompts[0]?.id);
    await Promise.all([loadRuns(), loadAgentGraph(), loadAgentRuns(), loadParamLab(), loadHomeworkState()]);
    applyView();
  } catch (error) {
    $("#task-title").textContent = "无法加载本地工作台";
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
    showToast(error.message, "error");
  }
}

initialize();
