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
  renderRichContent($("#hw-spec-content"), payload.task.spec, { format: "markdown" });
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

