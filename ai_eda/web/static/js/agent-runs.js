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
  summary.textContent = `${state.agent.runs.length} runs · ${passed} pass · ${failed} fail`;

  const chips = document.createElement("div");
  chips.className = "compare-summary";
  [
    ["RUNS", `${state.agent.runs.length}`, ""],
    ["PASS", `${passed}`, "pass"],
    ["FAIL", `${failed}`, "fail"],
    ["AVG TIME", averageDuration === null ? "—" : formatDuration(averageDuration), ""],
  ].forEach(([label, value, tone]) => {
    const chip = document.createElement("span");
    chip.className = `compare-chip ${tone}`;
    const strong = document.createElement("b");
    strong.textContent = label;
    chip.append(strong, document.createTextNode(value));
    chips.append(chip);
  });
  body.append(chips);

  const wrap = document.createElement("div");
  wrap.className = "compare-table-wrap";
  const table = document.createElement("table");
  table.className = "compare-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["运行", "结果", "轮次", "耗时", "Tokens", "Area / Power"].forEach((label, index) => {
    const th = document.createElement("th");
    th.textContent = label;
    if (index >= 2) th.className = "compare-num";
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
    addCell(formatDuration(run.duration_ms), "compare-num");
    addCell(run.total_tokens ? `${run.total_tokens}` : "—", "compare-num");
    const area = run.area !== null && run.area !== undefined ? Number(run.area).toFixed(3) : "—";
    const power = run.total_power_w !== null && run.total_power_w !== undefined
      ? `${(Number(run.total_power_w) * 1e6).toFixed(3)} µW`
      : "—";
    addCell(`${area} / ${power}`, "compare-num compare-metric");
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
  state.agent.detailScrollPositions.clear();
  state.agent.renderedDetailKey = "";
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
        max_calls: Number($("#agent-max-calls")?.value || 100),
        reasoning_effort: $("#agent-reasoning-effort").value,
        project_id: state.agent.projectId || "stream_filter",
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

function renderAgentProjectTabs() {
  const container = $("#agent-project-tabs");
  if (!container) return;
  container.replaceChildren();
  (state.agent.projects || []).forEach((project) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-project-tab ${project.id === state.agent.projectId ? "active" : ""}`;
    button.dataset.projectId = project.id;
    button.textContent = project.title;
    button.title = project.description || project.title;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", project.id === state.agent.projectId ? "true" : "false");
    button.addEventListener("click", () => switchAgentProject(project.id));
    container.append(button);
  });
  const description = $("#agent-project-description");
  if (description) description.textContent = state.agent.projectDescription || "";
}

async function switchAgentProject(projectId) {
  if (state.agent.running) {
    showToast("Agent 运行中，请完成或停止后再切换项目", "warning");
    return;
  }
  if (!projectId || projectId === state.agent.projectId) return;
  state.agent.projectId = projectId;
  state.agent.run = null;
  state.agent.job = null;
  state.agent.events = [];
  state.agent.selectedStep = null;
  state.agent.followLive = true;
  renderAgentResult(null);
  updateAgentRunStatus(null);
  await loadAgentGraph();
  await loadAgentRuns();
  renderAgentEvents();
  showToast(`已切换到「${state.agent.projectDescription || projectId}」`, "success");
}

async function loadAgentRuns() {
  const projectId = state.agent.projectId || "stream_filter";
  const payload = await api(`/api/agent/runs?project=${encodeURIComponent(projectId)}`);
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
    state.agent.detailScrollPositions.clear();
    state.agent.renderedDetailKey = "";
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
    const projectId = state.agent.projectId || "stream_filter";
    const result = await api(`/api/agent/runs?project=${encodeURIComponent(projectId)}`, { method: "DELETE" });
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
  const projectId = state.agent.projectId || "stream_filter";
  const [server, agentState] = await Promise.all([
    api("/api/agent/graph"),
    api(`/api/agent/state?project=${encodeURIComponent(projectId)}`),
  ]);
  state.agent.projectId = agentState.project?.id || projectId;
  state.agent.projects = agentState.projects || [];
  state.agent.projectDescription = agentState.project?.description || "";
  state.agent.spec = agentState.spec || "";
  renderAgentProjectTabs();
  state.agent.serverGraph = normalizeAgentGraph(server);
  state.agent.graph = JSON.parse(JSON.stringify(state.agent.serverGraph));
  state.agent.needsFit = true;
  renderAgentCanvas();
  updateFollowLiveButton();
  requestAnimationFrame(() => {
    if (!$("#agent-view").classList.contains("hidden")) fitAgentView();
  });
}

