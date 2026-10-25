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
    renderAgentEventDetail();
    return;
  }
  list.className = "agent-events";
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
    if (active) {
      // 只滚动 Steps 自己的容器，不能调用 scrollIntoView：
      // 那会同时滚动整个文档，导致流式更新期间页面被锁在底部。
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      if (activeRect.top < listRect.top) {
        list.scrollTop -= listRect.top - activeRect.top;
      } else if (activeRect.bottom > listRect.bottom) {
        list.scrollTop += activeRect.bottom - listRect.bottom;
      }
    }
  }
  renderAgentEventDetail();
}

function updateFollowLiveButton() {
  const button = $("#agent-follow-live");
  button.classList.toggle("active", state.agent.followLive);
  button.textContent = state.agent.followLive ? "跟随中" : "跟随最新";
}

function agentDetailTabs(event) {
  if (!event) return [];
  const isModelStep = ["parser", "planner", "coder", "modifier"].includes(event.node_id);
  if (event.node_id === "tester") {
    return [{ id: "tools", label: "工具输出" }];
  }
  const tabs = [];
  if (isModelStep) {
    tabs.push({ id: "prompt", label: "发送的 Prompt" });
    tabs.push({ id: "model", label: "模型输出" });
    if (event.rtl) tabs.push({ id: "rtl", label: "RTL / TB" });
  }
  if (!tabs.length && (event.response || event.reasoning || event.raw_response)) {
    tabs.push({ id: "model", label: "模型输出" });
  }
  return tabs;
}

function renderAgentDetailTabs(event) {
  const container = $("#agent-detail-tabs");
  const tabs = agentDetailTabs(event);
  const available = new Set(tabs.map((tab) => tab.id));
  if (!available.has(state.agent.detailTab)) {
    state.agent.detailTab = tabs[0]?.id || "";
  }
  container.replaceChildren();
  container.classList.toggle("hidden", !tabs.length);
  tabs.forEach((tab) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-detail-tab ${tab.id === state.agent.detailTab ? "active" : ""}`;
    button.dataset.agentDetail = tab.id;
    button.textContent = tab.label;
    button.addEventListener("click", () => {
      rememberAgentDetailScroll();
      state.agent.detailTab = tab.id;
      renderAgentEventDetail();
    });
    container.append(button);
  });
}

function agentDetailKey(event) {
  if (!event) return "";
  return `${event.run_id || "run"}:${event.step}:${state.agent.detailTab}`;
}

function rememberAgentDetailScroll() {
  const detail = $("#agent-detail-content");
  const key = state.agent.renderedDetailKey;
  if (detail && key) state.agent.detailScrollPositions.set(key, detail.scrollTop);
}

function restoreAgentDetailScroll(event) {
  const detail = $("#agent-detail-content");
  const key = agentDetailKey(event);
  state.agent.renderedDetailKey = key;
  if (!detail || !key) return;
  const saved = state.agent.detailScrollPositions.get(key);
  requestAnimationFrame(() => {
    if (state.agent.renderedDetailKey !== key) return;
    // 流式更新只恢复 Execution Trace 自己的滚动条，绝不滚动页面。
    detail.scrollTop = Number.isFinite(saved) ? saved : 0;
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

function detailPre(section, text, className = "", format = "auto") {
  const body = document.createElement("div");
  body.className = `trace-detail-code ${className}`.trim();
  renderRichContent(body, text || "—", { format });
  section.append(body);
  return body;
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
    detailPre(section, event.input_response, "", "markdown");
  }
  const parserAddendum = parsed.spec_addendum || parsed.refined_spec;
  if (parserAddendum) {
    const section = detailSection(container, "Parser 补充与修正");
    detailPre(section, parserAddendum, "", "markdown");
  }
  if (!missing.length && !questions.length && !event.input_response) {
    const section = detailSection(container, "结论");
    detailPre(section, event.response || "Spec 充分。", "", "markdown");
  }
}

function renderPlannerDetail(container, event) {
  const plan = parseEventJson(event) || {};
  if (!plan.modules?.length) {
    const section = detailSection(container, "规划结果");
    detailPre(section, event.response || "Planner 暂无输出。", "", "auto");
    return;
  }
  const meta = detailSection(container, "项目");
  detailPre(meta, { project: plan.project_name || "—", top_module: plan.top_module || "—" }, "", "json");
  const modules = detailSection(container, "模块 / 文件结构");
  detailPills(modules, plan.modules);
  if (plan.notes) {
    const notes = detailSection(container, "说明");
    detailPre(notes, plan.notes, "", "markdown");
  }
}

function renderTesterDetail(container, event) {
  const report = event.report || {};
  const verdict = document.createElement("div");
  verdict.className = `trace-verdict ${report.passed ? "pass" : "fail"}`;
  verdict.textContent = report.passed ? `Tester PASS · ${event.title}` : `Tester FAIL · ${event.title}`;
  container.append(verdict);
  const summary = detailSection(container, "验收结论");
  detailPre(summary, event.response || (report.passed ? "教师 TB 通过。" : "教师 TB 未通过。"), "", "markdown");
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
  detailPre(section, event.response || "Coder 暂无说明。", "", "markdown");
  if (event.rtl) {
    const code = detailSection(container, "本文件 RTL");
    detailPre(code, event.rtl, "", "code");
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
    detailPre(notes, parsed.notes, "", "markdown");
  }
  if (!files.length) {
    const section = detailSection(container, "修改结果");
    detailPre(section, event.response || "Modifier 暂无输出。", "", "auto");
  }
}

function appendStreamCursor(block) {
  const body = block?.querySelector(".response-block-body");
  if (!body) return;
  const cursor = document.createElement("span");
  cursor.className = "trace-stream-cursor";
  body.append(cursor);
}

function renderAgentModelOutput(container, event) {
  const running = event.status === "running";
  const frame = document.createElement("section");
  frame.className = "trace-model-frame";

  const reasoningText = event.reasoning || "";
  const reasoning = responseBlock(
    "思维链",
    "reasoning",
    reasoningText,
    running
      ? "正在等待模型流式返回思维链…"
      : "该步骤未返回可展示的模型推理文本。",
  );
  if (running) appendStreamCursor(reasoning);
  frame.append(reasoning);

  const answer = document.createElement("section");
  answer.className = "response-block response-answer";
  const answerLabel = document.createElement("p");
  answerLabel.className = "response-block-label";
  answerLabel.textContent = "模型回答";
  answer.append(answerLabel);

  const structured = !running && ["parser", "planner", "modifier"].includes(event.node_id);
  if (structured) {
    if (event.node_id === "parser") renderParserDetail(answer, event);
    else if (event.node_id === "planner") renderPlannerDetail(answer, event);
    else renderModifierDetail(answer, event);
  } else {
    const body = document.createElement("div");
    body.className = "response-block-body";
    const text = event.node_id === "coder"
      ? event.response
      : (event.raw_response || event.response);
    if (text) {
      if (running) body.textContent = text;
      else renderRichContent(body, text, { format: event.node_id === "coder" ? "code" : "auto" });
    } else {
      body.classList.add("response-block-note");
      body.textContent = running ? "正在流式生成模型回答…" : "该步骤没有模型回答。";
    }
    if (running) appendStreamCursor(answer);
    answer.append(body);
  }

  if (event.error) {
    const error = document.createElement("div");
    error.className = "trace-verdict fail";
    error.textContent = `执行失败：${event.error}`;
    answer.append(error);
  }
  frame.append(answer);
  container.append(frame);
}

function renderAgentDetailContent(event) {
  const container = $("#agent-detail-content");
  if (!container) return;
  container.replaceChildren();
  if (!event) {
    container.textContent = "选择一个运行步骤后，将在这里显示详细内容。";
    return;
  }
  const tab = state.agent.detailTab;
  if (tab === "prompt") {
    const section = detailSection(container, "发送的 Prompt");
    detailPre(section, event.prompt, "", "markdown");
    return;
  }
  if (tab === "rtl") {
    if (event.rtl) {
      const section = detailSection(container, "RTL / TB 数据");
      detailPre(section, event.rtl, "", "code");
    } else if (event.report) {
      const section = detailSection(container, "TB 报告");
      detailPre(section, JSON.stringify(event.report, null, 2), "", "json");
    } else {
      const section = detailSection(container, "RTL / TB 数据");
      detailPre(section, "该步骤没有 RTL 或 TB 数据。");
    }
    return;
  }
  if (tab === "tools") {
    if (!event.report) {
      const section = detailSection(container, "工具输出");
      detailPre(section, "工具正在执行，完成后会在下方窗口展示。");
    }
    return;
  }
  if (tab === "model") {
    renderAgentModelOutput(container, event);
    return;
  }
  const section = detailSection(container, "运行步骤");
  detailPre(section, "该步骤没有可展示的输出。");
}

function renderAgentEventDetail() {
  rememberAgentDetailScroll();
  state.agent.renderedDetailKey = "";
  const event = selectedEvent();
  renderAgentDetailTabs(event);
  renderAgentDetailContent(event);

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

  const showToolWindow = state.agent.detailTab === "tools" && Boolean(event?.report);
  $("#agent-detail-content").classList.toggle("hidden", showToolWindow);
  const visual = $("#agent-verify-visual");
  if (showToolWindow) {
    visual.classList.remove("hidden");
    renderAgentVerifyVisual(event.report);
  } else {
    visual.classList.add("hidden");
  }
  if (!showToolWindow) restoreAgentDetailScroll(event);
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

const CPU_REPORT_LABELS = {
  expected_level: "目标层级",
  declared_level: "声明层级",
  verified_level: "验证层级",
  observed_level: "观测层级",
  level: "层级",
  features: "特性",
  cache: "I/D Cache",
  predictor: "分支预测",
  ooo: "乱序执行",
  branch_predictor: "分支预测",
  out_of_order: "乱序执行",
  checks: "检查数",
  name: "名称",
};

function cpuReportValue(value) {
  if (Array.isArray(value)) return value.join("、");
  if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}: ${item}`).join(" · ");
  return String(value ?? "—");
}

function cpuReportSection(title) {
  const section = document.createElement("section");
  section.className = "cpu-report-section";
  const heading = document.createElement("h4");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function renderAgentCpuSummary(report) {
  const panel = $("#agent-cpu-summary");
  if (!panel) return;
  panel.replaceChildren();
  const capability = report.cpu_capability && typeof report.cpu_capability === "object"
    ? report.cpu_capability : {};
  const suites = Array.isArray(report.test_suites) ? report.test_suites : [];
  const benchmarks = Array.isArray(report.performance?.benchmarks) ? report.performance.benchmarks : [];
  if (!Object.keys(capability).length && !suites.length && !benchmarks.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const heading = document.createElement("div");
  heading.className = "cpu-report-head";
  const title = document.createElement("strong");
  title.textContent = "CPU 能力与性能";
  const detail = document.createElement("span");
  const level = capability.verified_level ?? capability.observed_level ?? capability.declared_level ?? capability.level;
  detail.textContent = level === undefined ? "分层验收" : `已识别 L${level}`;
  heading.append(title, detail);
  panel.append(heading);

  if (Object.keys(capability).length) {
    const section = cpuReportSection("能力识别");
    const grid = document.createElement("div");
    grid.className = "cpu-capability-grid";
    const preferred = ["expected_level", "declared_level", "verified_level", "observed_level", "features", "name"];
    const entries = Object.entries(capability).filter(([key]) => preferred.includes(key));
    if (!entries.length && capability.level !== undefined) entries.push(["level", capability.level]);
    entries.forEach(([key, value]) => {
      const item = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = CPU_REPORT_LABELS[key] || key.replaceAll("_", " ");
      const result = document.createElement("b");
      result.textContent = key.endsWith("level") || key === "level" ? `L${cpuReportValue(value)}` : cpuReportValue(value);
      item.append(label, result);
      grid.append(item);
    });
    section.append(grid);
    panel.append(section);
  }

  if (suites.length) {
    const section = cpuReportSection("验收测试组");
    const list = document.createElement("div");
    list.className = "cpu-suite-list";
    suites.forEach((suite) => {
      const row = document.createElement("div");
      const skipped = Boolean(suite.skipped);
      row.className = `cpu-suite ${skipped ? "skip" : suite.passed === false ? "fail" : "pass"}`;
      const name = document.createElement("strong");
      name.textContent = suite.name || suite.suite || "测试组";
      const status = document.createElement("span");
      status.textContent = skipped ? "SKIP" : suite.passed === false ? "FAIL" : "PASS";
      const note = document.createElement("small");
      note.textContent = suite.checks ?? suite.detail ?? "";
      row.append(name, status, note);
      list.append(row);
    });
    section.append(list);
    panel.append(section);
  }

  if (benchmarks.length) {
    const section = cpuReportSection("性能基准");
    const table = document.createElement("table");
    table.className = "cpu-performance-table";
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    ["基准", "Cycles", "Retired", "CPI", "IPC"].forEach((text) => {
      const cell = document.createElement("th");
      cell.textContent = text;
      row.append(cell);
    });
    head.append(row);
    const body = document.createElement("tbody");
    benchmarks.forEach((benchmark) => {
      const line = document.createElement("tr");
      [
        benchmark.benchmark || benchmark.name || "benchmark",
        benchmark.cycles ?? "—",
        benchmark.instructions ?? benchmark.retired ?? "—",
        Number.isFinite(Number(benchmark.cpi)) ? Number(benchmark.cpi).toFixed(3) : "—",
        Number.isFinite(Number(benchmark.ipc)) ? Number(benchmark.ipc).toFixed(3) : "—",
      ].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        line.append(cell);
      });
      body.append(line);
    });
    table.append(head, body);
    section.append(table);
    panel.append(section);
  }
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
  renderAgentCpuSummary(report);
  renderAgentDftSpectrum(report);
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

function renderAgentDftSpectrum(report) {
  const chart = $("#agent-dft-chart");
  const bars = $("#agent-dft-bars");
  if (!chart || !bars) return;
  const rows = (report.trace || []).filter(
    (row) => row.test === "t13_dft" && row.event === "bin",
  );
  if (!rows.length) {
    chart.classList.add("hidden");
    bars.replaceChildren();
    return;
  }
  chart.classList.remove("hidden");
  bars.replaceChildren();
  const magnitudes = rows.map((row) => Math.abs(Number(row.mag) || 0));
  const maxMagnitude = Math.max(...magnitudes, 1);
  rows.forEach((row, index) => {
    const magnitude = Math.abs(Number(row.mag) || 0);
    const bin = document.createElement("div");
    bin.className = "dft-bin";
    bin.title = `k=${row.k}  Re=${row.re}  Im=${row.im}  |Re|+|Im|=${magnitude}`;
    const track = document.createElement("div");
    track.className = "dft-bar-track";
    const bar = document.createElement("div");
    bar.className = `dft-bar ${index === 0 ? "dc" : ""}`;
    bar.style.height = `${Math.max(4, Math.round((magnitude / maxMagnitude) * 100))}%`;
    track.append(bar);
    const label = document.createElement("span");
    label.className = "dft-bin-label";
    label.textContent = `k${row.k}`;
    const value = document.createElement("span");
    value.className = "dft-bin-value";
    value.textContent = String(magnitude);
    bin.append(track, label, value);
    bars.append(bin);
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

