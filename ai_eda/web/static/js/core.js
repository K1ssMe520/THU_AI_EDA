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
    projectId: null,
    projects: [],
    projectDescription: "",
    graph: null,
    serverGraph: null,
    spec: "",
    result: null,
    designs: [],
    runs: [],
    designId: null,
    designName: null,
    designBaseline: null,
    selectedNodeId: null,
    saveTimer: null,
    detailTab: "model",
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
    detailScrollPositions: new Map(),
    renderedDetailKey: "",
    view: { x: 48, y: 48, scale: 1 },
    needsFit: true,
    history: { past: [], future: [], editSnapshot: null },
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

const RICH_ALLOWED_TAGS = new Set([
  "A", "BLOCKQUOTE", "BR", "CODE", "DEL", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HR", "LI", "OL", "P", "PRE", "STRONG", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
]);
const RICH_BLOCKED_TAGS = new Set(["APPLET", "EMBED", "IFRAME", "OBJECT", "SCRIPT", "STYLE", "SVG"]);

function parseJsonText(value) {
  if (typeof value !== "string") return null;
  const source = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!/^[{[]/.test(source)) return null;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function sanitizeMarkdownHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  [...template.content.querySelectorAll("*")].forEach((element) => {
    const tag = element.tagName;
    if (RICH_BLOCKED_TAGS.has(tag)) {
      element.remove();
      return;
    }
    if (!RICH_ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...element.childNodes);
      return;
    }
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") {
        element.removeAttribute(attribute.name);
      }
    });
    if (tag === "A") {
      const href = element.getAttribute("href") || "";
      if (href && !/^(https?:|mailto:|#|\/)/i.test(href)) element.removeAttribute("href");
      element.setAttribute("rel", "noopener noreferrer");
      element.setAttribute("target", "_blank");
    }
  });
  return template.innerHTML;
}

function jsonValueNode(value, label = "", depth = 0) {
  const isCollection = Array.isArray(value) || (value && typeof value === "object");
  if (!isCollection) {
    const row = document.createElement("div");
    row.className = "json-leaf";
    if (label) {
      const key = document.createElement("span");
      key.className = "json-key";
      key.textContent = label;
      row.append(key);
    }
    const token = document.createElement("code");
    const kind = value === null ? "null" : typeof value;
    token.className = `json-token ${kind}`;
    token.textContent = typeof value === "string" ? `“${value}”` : String(value);
    row.append(token);
    return row;
  }
  const details = document.createElement("details");
  details.className = "json-branch";
  details.open = depth < 2;
  const summary = document.createElement("summary");
  const key = document.createElement("span");
  key.className = "json-key";
  key.textContent = label || (Array.isArray(value) ? "数组" : "对象");
  const meta = document.createElement("span");
  meta.className = "json-meta";
  meta.textContent = Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
  summary.append(key, meta);
  details.append(summary);
  const children = document.createElement("div");
  children.className = "json-children";
  const entries = Array.isArray(value) ? value.map((entry, index) => [String(index), entry]) : Object.entries(value);
  entries.forEach(([childKey, childValue]) => children.append(jsonValueNode(childValue, childKey, depth + 1)));
  details.append(children);
  return details;
}

function renderJsonContent(container, value) {
  container.replaceChildren();
  const root = document.createElement("div");
  root.className = "rich-json";
  root.append(jsonValueNode(value));
  container.append(root);
}

function renderMarkdownContent(container, markdown) {
  container.replaceChildren();
  const root = document.createElement("div");
  root.className = "rich-markdown";
  const source = String(markdown || "");
  if (globalThis.marked?.parse) {
    try {
      root.innerHTML = sanitizeMarkdownHtml(globalThis.marked.parse(source, {
        breaks: true,
        gfm: true,
      }));
    } catch (_) {
      root.textContent = source;
    }
  } else {
    root.textContent = source;
  }
  container.append(root);
}

function renderCodeContent(container, text) {
  container.replaceChildren();
  const pre = document.createElement("pre");
  pre.className = "rich-code";
  pre.textContent = String(text || "—");
  container.append(pre);
}

function renderRichContent(container, value, { format = "auto" } = {}) {
  if (!container) return;
  if (format === "json" && value && typeof value === "object") {
    renderJsonContent(container, value);
    return;
  }
  const text = String(value ?? "");
  const json = format === "json" ? parseJsonText(text) : format === "auto" ? parseJsonText(text) : null;
  if (format === "json" && json === null) return renderCodeContent(container, text);
  if (json !== null) return renderJsonContent(container, json);
  if (format === "code") return renderCodeContent(container, text);
  renderMarkdownContent(container, text);
}

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

