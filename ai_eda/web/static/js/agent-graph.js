/* --------------------------- Agent graph helpers --------------------------- */

const NODE_DEFAULTS = {
  model: {
    title: "New Model Step",
    prompt: "根据以下冻结规格生成可编译的 SystemVerilog RTL。最终输出只能包含一个 RTL 模块，不要输出 Markdown、解释、testbench 或其他模块。\n\n{spec}\n\n如果提供了上一轮验证反馈，请先修复其中的问题：\n{verify_feedback}",
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
    }
    return node;
  });
  rawNodes.forEach((raw) => {
    if (!raw || !kept.includes(raw.id) || !raw.retry || !kept.includes(raw.retry.target)) return;
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
  renderRichContent($("#agent-detail-prompt"), node.prompt, { format: "markdown" });
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
    renderRichContent(content, state.agent.spec || "尚未载入任务 Spec。", { format: "markdown" });
  } else {
    label.textContent = "FIXED OUTPUT · FINAL RESULT";
    title.textContent = "最终 Summary（只读）";
    const result = state.agent.result;
    if (!result) {
      renderRichContent(content, "尚未运行 Agent。运行结束后，这里会显示最终教师 TB、面积与功耗结果。", { format: "markdown" });
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
      renderRichContent(content, lines.join("\n"), { format: "markdown" });
    }
  }
  $("#agent-fixed-dialog").showModal();
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

