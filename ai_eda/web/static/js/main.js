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
  const detail = $("#agent-detail-content");
  detail.addEventListener("scroll", () => {
    const key = state.agent.renderedDetailKey;
    if (key) state.agent.detailScrollPositions.set(key, detail.scrollTop);
  }, { passive: true });
  $("#agent-copy-detail").addEventListener("click", async () => {
    try {
      const toolWindow = $("#agent-verify-visual");
      const source = toolWindow && !toolWindow.classList.contains("hidden")
        ? toolWindow
        : $("#agent-detail-content");
      await navigator.clipboard.writeText(source.textContent || "");
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
