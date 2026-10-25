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

const HANDOFF_FIELD_LABELS = {
  attempt: "测试轮次",
  task: "任务",
  summary: "交接摘要",
  notes: "修复说明",
  changed_paths: "已修改文件",
};

function handoffFieldValue(value) {
  if (Array.isArray(value)) return value.join("、") || "—";
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value ?? "—");
}

function renderAgentHandoffContent(container, item) {
  container.replaceChildren();
  const payload = item.payload && typeof item.payload === "object" ? item.payload : {};
  const fields = Object.entries(payload).filter(([key]) => key !== "artifacts");
  if (fields.length) {
    const message = document.createElement("section");
    message.className = "handoff-message-card";
    const label = document.createElement("span");
    label.className = "handoff-card-label";
    label.textContent = "交接说明";
    message.append(label);
    const list = document.createElement("dl");
    fields.forEach(([key, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = HANDOFF_FIELD_LABELS[key] || key.replaceAll("_", " ");
      const detail = document.createElement("dd");
      renderRichContent(detail, handoffFieldValue(value));
      row.append(term, detail);
      list.append(row);
    });
    message.append(list);
    container.append(message);
  }

  const previews = Array.isArray(item.artifact_previews) ? item.artifact_previews : [];
  if (!previews.length) {
    const empty = document.createElement("p");
    empty.className = "handoff-empty";
    empty.textContent = "该交接尚未生成可展示的文本内容。";
    container.append(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "handoff-artifact-grid";
  previews.forEach((artifact) => {
    const card = document.createElement("section");
    card.className = "handoff-artifact-card";
    const heading = document.createElement("div");
    heading.className = "handoff-artifact-heading";
    const title = document.createElement("strong");
    title.textContent = artifact.title || "交接文本";
    const state = document.createElement("small");
    state.textContent = artifact.truncated ? "已截断" : "完整文本";
    heading.append(title, state);
    const text = document.createElement("div");
    text.className = "handoff-artifact-content";
    renderRichContent(text, artifact.content || "（空文本）");
    card.append(heading, text);
    grid.append(card);
  });
  container.append(grid);
}

function handoffEdgeId(source, target) {
  return `${source}_to_${target}`;
}

function addHandoffHitArea(svg, pathData, edgeId, visiblePath = null) {
  const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hit.setAttribute("d", pathData);
  hit.setAttribute("class", "agent-edge-hit");
  hit.dataset.handoff = edgeId;
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = `${HANDOFF_LABELS[edgeId] || edgeId} · 点击查看交接文本`;
  hit.append(title);
  hit.addEventListener("mouseenter", () => visiblePath?.classList.add("handoff-hover"));
  hit.addEventListener("mouseleave", () => visiblePath?.classList.remove("handoff-hover"));
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
  $("#agent-handoff-meta").textContent = `${payload.run_id} · ${items.length} 个交接版本 · 展示实际交接文本`;
  const tabs = $("#agent-handoff-tabs");
  tabs.replaceChildren();
  const content = $("#agent-handoff-content");
  const showItem = (index) => {
    const item = items[index];
    renderAgentHandoffContent(content, item);
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
    addHandoffHitArea(svg, pathData, handoffEdgeId(edge.from, edge.to), path);
  });
  graph.nodes.forEach((node) => {
    if (!node.retry) return;
    const target = agentNode(node.retry.target);
    if (!target) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const pathData = retryEdgePath(node, target);
    path.setAttribute("d", pathData);
    path.setAttribute("class", "agent-edge retry-edge");
    path.setAttribute("marker-end", "url(#arrow-retry)");
    path.dataset.edge = `${node.id}->${node.retry.target}`;
    svg.append(path);
    addHandoffHitArea(svg, pathData, handoffEdgeId(node.id, node.retry.target), path);
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
      addHandoffHitArea(svg, edge.d, edge.id, path);
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

