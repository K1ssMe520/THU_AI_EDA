const state = {
  task: null,
  prompts: new Map(),
  activePromptId: null,
  activeResponseTab: "reasoning",
  lastRun: null,
  saveTimer: null,
  agent: {
    graph: null,
    selectedNodeId: null,
    saveTimer: null,
    detailTab: "prompt",
    run: null,
    selectedEventIndex: null,
  },
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function localKey(id) { return `ai-eda-prompt-draft:${id}`; }

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function setSaveStatus(text, mode = "") {
  const node = $("#save-status");
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
  const localDraft = localStorage.getItem(localKey(id));
  $("#prompt-editor").value = localDraft ?? prompt.content;
  $("#prompt-description").textContent = prompt.description;
  $("#prompt-file").textContent = prompt.file;
  setSaveStatus(localDraft === null ? "已读取本地文件" : "已恢复浏览器草稿", localDraft === null ? "saved" : "");
  buildStageList();
}

async function savePrompt() {
  const prompt = activePrompt();
  if (!prompt) return;
  const content = $("#prompt-editor").value;
  localStorage.setItem(localKey(prompt.id), content);
  setSaveStatus("正在保存…", "saving");
  try {
    await api(`/api/prompts/${prompt.id}`, { method: "PUT", body: JSON.stringify({ content }) });
    prompt.content = content;
    localStorage.removeItem(localKey(prompt.id));
    setSaveStatus("已保存到本地文件", "saved");
  } catch (error) {
    setSaveStatus("保存失败，草稿仍在浏览器", "error");
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
    throw error;
  }
}

function scheduleSave() {
  const prompt = activePrompt();
  if (!prompt) return;
  localStorage.setItem(localKey(prompt.id), $("#prompt-editor").value);
  setSaveStatus("浏览器草稿已保存", "saving");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => savePrompt().catch(() => {}), 650);
}

function responseText() {
  if (!state.lastRun) return "运行后将在这里显示服务端返回的推理文本；若模型未返回可展示的 reasoning_content，会明确提示。";
  if (state.activeResponseTab === "reasoning") {
    return state.lastRun.reasoning || "该次调用未返回可展示的推理文本。可启用“请求模型思考文本”后重新运行；最终 RTL 是否正确仍以 TB 为准。";
  }
  if (state.activeResponseTab === "answer") return state.lastRun.answer || "模型未返回最终回答。";
  return state.lastRun.rtl || "未能从模型回答中提取 RTL。";
}

function renderResponse() {
  $("#response-content").textContent = responseText();
  document.querySelectorAll(".response-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.responseTab === state.activeResponseTab);
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
  $("#run-id-label").textContent = run.run_id;
  $("#run-status").textContent = `完成：${run.run_id}`;
  $("#run-status").className = "run-status";
  renderResponse();
  renderReport(run.report || {});
}

async function runPrompt() {
  const button = $("#run-button");
  const prompt = activePrompt();
  if (!prompt) return;
  button.disabled = true;
  $("#run-status").textContent = "正在保存 Prompt、请求模型并运行教师 TB…";
  $("#run-status").className = "run-status running";
  try {
    clearTimeout(state.saveTimer);
    await savePrompt();
    const run = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        task_id: state.task.id,
        prompt_id: prompt.id,
        content: $("#prompt-editor").value,
        temperature: Number($("#temperature").value),
        max_tokens: Number($("#max-tokens").value),
        thinking: $("#thinking").checked,
        reasoning_effort: $("#reasoning-effort").value,
      }),
    });
    renderRun(run);
    await loadRuns();
  } catch (error) {
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
  } finally {
    button.disabled = false;
  }
}

async function loadRun(runId) {
  try { renderRun(await api(`/api/runs/${state.task.id}/${runId}`)); }
  catch (error) { $("#run-status").textContent = error.message; $("#run-status").className = "run-status error"; }
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
}

async function deleteRun(runId) {
  if (!window.confirm(`删除运行记录“${runId}”？此操作不可恢复。`)) return;
  try {
    await api(`/api/runs/${state.task.id}/${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (state.lastRun?.run_id === runId) state.lastRun = null;
    await loadRuns();
    $("#run-status").textContent = `已删除：${runId}`;
    $("#run-status").className = "run-status";
  } catch (error) {
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
  }
}

async function clearRuns() {
  if (!window.confirm("清空本任务的全部运行记录？此操作不可恢复。")) return;
  try {
    await api(`/api/runs/${state.task.id}`, { method: "DELETE" });
    state.lastRun = null;
    renderResponse();
    renderReport({});
    $("#run-id-label").textContent = "尚未运行";
    await loadRuns();
    $("#run-status").textContent = "已清空全部运行记录。";
    $("#run-status").className = "run-status";
  } catch (error) {
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
  }
}

function activateMainTab(name) {
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.mainTab === name));
  $("#prompt-view").classList.toggle("hidden", name !== "prompt");
  $("#agent-view").classList.toggle("hidden", name !== "agent");
}

function activatePromptTab(name) {
  document.querySelectorAll(".sub-tab").forEach((button) => button.classList.toggle("active", button.dataset.promptTab === name));
  $("#teaching-view").classList.toggle("hidden", name !== "teaching");
  $("#homework-view").classList.toggle("hidden", name !== "homework");
}

const NODE_DEFAULTS = {
  spec: { title: "New Spec", prompt: "在这里写入完整、可执行的设计规格。" },
  model: { title: "New Model Step", prompt: "根据以下冻结规格生成可编译的 SystemVerilog RTL。最终输出只能包含一个 RTL 模块，不要输出 Markdown、解释、testbench 或其他模块。\n\n{spec}" },
  verify: { title: "New Verify Step", prompt: "使用固定教师 TB 验证当前生成 RTL。" },
  report: { title: "New Report Step", prompt: "汇总本次 Agent 运行结果。" },
};

function agentGraph() { return state.agent.graph; }
function agentNode(id) { return agentGraph()?.nodes.find((node) => node.id === id); }
function agentNext(id) { return agentGraph()?.edges.find((edge) => edge.from === id)?.to || ""; }
function agentGlyph(type) {
  return {
    spec: ["▤", "spec-glyph"], model: ["✦", "model-glyph"],
    verify: ["✓", "verify-glyph"], report: ["≡", "report-glyph"],
  }[type] || ["?", "report-glyph"];
}

function setAgentSaveStatus(text, mode = "") {
  const node = $("#agent-save-status");
  node.textContent = text;
  node.className = `save-status ${mode}`;
}

function drawAgentEdges() {
  const canvas = $("#agent-canvas");
  const svg = $("#agent-edges");
  const width = Math.max(canvas.scrollWidth, 1100);
  const height = Math.max(canvas.scrollHeight, 490);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.querySelectorAll("line").forEach((line) => line.remove());
  (agentGraph()?.edges || []).forEach((edge) => {
    const from = agentNode(edge.from);
    const to = agentNode(edge.to);
    if (!from || !to) return;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(Number(from.x) + 208));
    line.setAttribute("y1", String(Number(from.y) + 50));
    line.setAttribute("x2", String(Number(to.x)));
    line.setAttribute("y2", String(Number(to.y) + 50));
    svg.append(line);
  });
}

function renderAgentCanvas() {
  const graph = agentGraph();
  if (!graph) return;
  $("#agent-name").textContent = graph.name;
  const layer = $("#agent-nodes");
  layer.replaceChildren();
  $("#canvas-empty").classList.toggle("hidden", graph.nodes.length > 0);
  graph.nodes.forEach((node) => {
    const [glyph, glyphClass] = agentGlyph(node.type);
    const element = document.createElement("div");
    element.className = `agent-node ${node.id === state.agent.selectedNodeId ? "selected" : ""}`;
    element.dataset.nodeId = node.id;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    element.innerHTML = `<div class="agent-node-top"><span class="node-glyph ${glyphClass}">${glyph}</span><span class="agent-node-title">${escapeHtml(node.title)}</span></div><div class="agent-node-type">${escapeHtml(node.type.toUpperCase())}</div><div class="agent-node-preview">${escapeHtml(node.prompt)}</div>`;
    bindNodeDrag(element, node);
    layer.append(element);
  });
  requestAnimationFrame(drawAgentEdges);
}

function bindNodeDrag(element, node) {
  let start = null;
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    start = { x: event.clientX, y: event.clientY, nodeX: Number(node.x), nodeY: Number(node.y), moved: false };
    element.classList.add("dragging");
  });
  element.addEventListener("pointermove", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) start.moved = true;
    node.x = Math.max(0, Math.round((start.nodeX + dx) / 16) * 16);
    node.y = Math.max(0, Math.round((start.nodeY + dy) / 16) * 16);
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    drawAgentEdges();
  });
  const release = (event) => {
    if (!start) return;
    element.classList.remove("dragging");
    if (!start.moved) selectAgentNode(node.id);
    else scheduleAgentSave();
    start = null;
    try { element.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
  };
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
}

function setAgentNext(sourceId, targetId) {
  const graph = agentGraph();
  graph.edges = graph.edges.filter((edge) => edge.from !== sourceId && (!targetId || edge.to !== targetId));
  if (targetId) graph.edges.push({ from: sourceId, to: targetId });
}

function selectAgentNode(nodeId) {
  const node = agentNode(nodeId);
  if (!node) return;
  state.agent.selectedNodeId = nodeId;
  $("#selected-node-type").textContent = node.type.toUpperCase();
  $("#agent-inspector-empty").classList.add("hidden");
  $("#agent-node-form").classList.remove("hidden");
  $("#agent-node-title").value = node.title;
  $("#agent-node-prompt").value = node.prompt;
  const next = $("#agent-node-next");
  next.replaceChildren();
  next.append(new Option("结束流程", ""));
  agentGraph().nodes.filter((candidate) => candidate.id !== node.id).forEach((candidate) => {
    next.append(new Option(`${candidate.title} (${candidate.type})`, candidate.id));
  });
  next.value = agentNext(node.id);
  renderAgentCanvas();
}

async function saveAgentGraph() {
  const graph = agentGraph();
  if (!graph) return;
  localStorage.setItem("ai-eda-agent-graph-draft", JSON.stringify(graph));
  setAgentSaveStatus("正在保存…", "saving");
  try {
    const saved = await api("/api/agent/graph", { method: "PUT", body: JSON.stringify(graph) });
    state.agent.graph = saved;
    localStorage.removeItem("ai-eda-agent-graph-draft");
    setAgentSaveStatus("流程已保存", "saved");
  } catch (error) {
    setAgentSaveStatus("保存失败，浏览器保留草稿", "error");
    $("#agent-run-status").textContent = error.message;
  }
}

function scheduleAgentSave() {
  if (!agentGraph()) return;
  localStorage.setItem("ai-eda-agent-graph-draft", JSON.stringify(agentGraph()));
  setAgentSaveStatus("浏览器草稿已保存", "saving");
  clearTimeout(state.agent.saveTimer);
  state.agent.saveTimer = setTimeout(() => saveAgentGraph().catch(() => {}), 650);
}

function addAgentNode(type, x = 64, y = 300) {
  const graph = agentGraph();
  if (!graph || !NODE_DEFAULTS[type]) return;
  const base = `node_${Date.now().toString(36)}`;
  const id = graph.nodes.some((node) => node.id === base) ? `${base}_${graph.nodes.length}` : base;
  graph.nodes.push({ id, type, title: NODE_DEFAULTS[type].title, prompt: NODE_DEFAULTS[type].prompt, x: Math.round(x / 16) * 16, y: Math.round(y / 16) * 16 });
  if (!graph.entry) graph.entry = id;
  selectAgentNode(id);
  scheduleAgentSave();
}

function saveSelectedAgentNode(event) {
  event.preventDefault();
  updateSelectedAgentNodeDraft(true);
}

function updateSelectedAgentNodeDraft(renderCanvas = false) {
  const node = agentNode(state.agent.selectedNodeId);
  if (!node) return;
  node.title = $("#agent-node-title").value.trim() || NODE_DEFAULTS[node.type].title;
  node.prompt = $("#agent-node-prompt").value;
  setAgentNext(node.id, $("#agent-node-next").value);
  if (renderCanvas) renderAgentCanvas();
  scheduleAgentSave();
}

function deleteSelectedAgentNode() {
  const graph = agentGraph();
  const id = state.agent.selectedNodeId;
  if (!graph || !id) return;
  if (id === graph.entry) {
    $("#agent-run-status").textContent = "入口节点不能删除；请先在本地文件中指定新的入口节点。";
    return;
  }
  graph.nodes = graph.nodes.filter((node) => node.id !== id);
  graph.edges = graph.edges.filter((edge) => edge.from !== id && edge.to !== id);
  state.agent.selectedNodeId = null;
  $("#agent-node-form").classList.add("hidden");
  $("#agent-inspector-empty").classList.remove("hidden");
  $("#selected-node-type").textContent = "NO NODE";
  renderAgentCanvas();
  scheduleAgentSave();
}

function agentEventDetail(event) {
  if (!event) return "选择一个运行步骤后，将在这里显示详细内容。";
  if (state.agent.detailTab === "prompt") return event.prompt || "该步骤没有 Prompt。";
  if (state.agent.detailTab === "reasoning") return event.reasoning || "该步骤未返回可展示的模型推理文本。";
  if (state.agent.detailTab === "rtl") {
    if (event.rtl) return event.rtl;
    if (event.report) return JSON.stringify(event.report, null, 2);
    return "该步骤没有 RTL 或 TB 数据。";
  }
  return event.response || (event.report ? JSON.stringify(event.report, null, 2) : "该步骤没有输出。");
}

function renderAgentEventDetail() {
  const event = state.agent.run?.events?.[state.agent.selectedEventIndex];
  $("#agent-detail-content").textContent = agentEventDetail(event);
  document.querySelectorAll(".agent-detail-tab").forEach((button) => button.classList.toggle("active", button.dataset.agentDetail === state.agent.detailTab));
}

function renderAgentEvents() {
  const list = $("#agent-events");
  const events = state.agent.run?.events || [];
  list.replaceChildren();
  if (!events.length) {
    list.className = "agent-events empty-copy";
    list.textContent = "运行后会在此列出每一步。";
    renderAgentEventDetail();
    return;
  }
  list.className = "agent-events";
  events.forEach((event, index) => {
    const button = document.createElement("button");
    button.className = `agent-event ${index === state.agent.selectedEventIndex ? "active" : ""}`;
    const result = event.report ? (event.report.passed ? "TB PASS" : "TB FAIL") : event.node_type.toUpperCase();
    button.innerHTML = `<strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(result)}</small>`;
    button.addEventListener("click", () => { state.agent.selectedEventIndex = index; renderAgentEvents(); });
    list.append(button);
  });
  renderAgentEventDetail();
}

async function runAgent() {
  const button = $("#agent-run-button");
  if (!agentGraph()) return;
  button.disabled = true;
  $("#agent-run-status").textContent = "正在保存流程、调用模型并执行教师 TB…";
  try {
    clearTimeout(state.agent.saveTimer);
    await saveAgentGraph();
    const result = await api("/api/agent/run", {
      method: "POST",
      body: JSON.stringify({
        graph: agentGraph(),
        thinking: $("#agent-thinking").checked,
        temperature: Number($("#agent-temperature").value),
      }),
    });
    state.agent.run = result;
    state.agent.selectedEventIndex = 0;
    $("#agent-run-status").textContent = `完成：${result.run_id}`;
    renderAgentEvents();
  } catch (error) {
    $("#agent-run-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadAgentGraph() {
  const graph = await api("/api/agent/graph");
  try {
    const localDraft = localStorage.getItem("ai-eda-agent-graph-draft");
    state.agent.graph = localDraft ? JSON.parse(localDraft) : graph;
    setAgentSaveStatus(localDraft ? "已恢复浏览器草稿" : "流程已载入", localDraft ? "" : "saved");
  } catch (_) {
    state.agent.graph = graph;
    setAgentSaveStatus("流程已载入", "saved");
  }
  renderAgentCanvas();
}

function bindEvents() {
  document.querySelectorAll("[data-main-tab]").forEach((button) => button.addEventListener("click", () => activateMainTab(button.dataset.mainTab)));
  document.querySelectorAll("[data-prompt-tab]").forEach((button) => button.addEventListener("click", () => activatePromptTab(button.dataset.promptTab)));
  document.querySelectorAll("[data-response-tab]").forEach((button) => button.addEventListener("click", () => { state.activeResponseTab = button.dataset.responseTab; renderResponse(); }));
  $("#prompt-editor").addEventListener("input", scheduleSave);
  $("#prompt-editor").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); savePrompt().catch(() => {}); }
  });
  $("#run-button").addEventListener("click", runPrompt);
  $("#refresh-runs").addEventListener("click", () => loadRuns().catch(() => {}));
  $("#clear-runs").addEventListener("click", clearRuns);
  $("#agent-node-form").addEventListener("submit", saveSelectedAgentNode);
  $("#agent-delete-node").addEventListener("click", deleteSelectedAgentNode);
  $("#agent-run-button").addEventListener("click", runAgent);
  $("#agent-node-title").addEventListener("input", () => updateSelectedAgentNodeDraft(false));
  $("#agent-node-prompt").addEventListener("input", () => updateSelectedAgentNodeDraft(false));
  $("#agent-node-next").addEventListener("change", () => updateSelectedAgentNodeDraft(true));
  document.querySelectorAll(".agent-detail-tab").forEach((button) => button.addEventListener("click", () => { state.agent.detailTab = button.dataset.agentDetail; renderAgentEventDetail(); }));
  document.querySelectorAll(".palette-item").forEach((item) => {
    item.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", item.dataset.nodeType));
    item.addEventListener("click", () => addAgentNode(item.dataset.nodeType, 64 + (agentGraph()?.nodes.length || 0) * 16, 300));
  });
  const canvas = $("#agent-canvas");
  canvas.addEventListener("dragover", (event) => event.preventDefault());
  canvas.addEventListener("drop", (event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("text/plain");
    const rect = canvas.getBoundingClientRect();
    addAgentNode(type, event.clientX - rect.left - 100, event.clientY - rect.top - 40);
  });
}

async function initialize() {
  bindEvents();
  try {
    const payload = await api("/api/state");
    state.task = payload.task;
    payload.task.prompts.forEach((prompt) => state.prompts.set(prompt.id, prompt));
    $("#task-title").textContent = payload.task.title;
    $("#spec-content").textContent = payload.task.spec;
    selectPrompt(payload.task.prompts[0]?.id);
    await Promise.all([loadRuns(), loadAgentGraph()]);
  } catch (error) {
    $("#task-title").textContent = "无法加载本地工作台";
    $("#run-status").textContent = error.message;
    $("#run-status").className = "run-status error";
  }
}

initialize();
