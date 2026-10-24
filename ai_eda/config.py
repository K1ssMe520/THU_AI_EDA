"""项目路径约定：代码在 ai_eda/，内容在 content/，运行记录在 runs/。"""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONTENT_ROOT = PROJECT_ROOT / "content"
TASKS_ROOT = CONTENT_ROOT / "tasks"
PROMPTS_ROOT = CONTENT_ROOT / "prompts"
AGENT_CONTENT_ROOT = CONTENT_ROOT / "agent"
AGENT_FLOW_PATH = AGENT_CONTENT_ROOT / "simple_eda_agent.json"
RUNS_ROOT = PROJECT_ROOT / "runs"
PROMPT_RUNS_ROOT = RUNS_ROOT / "prompt"
AGENT_RUNS_ROOT = RUNS_ROOT / "agent"
WEB_ROOT = Path(__file__).resolve().parent / "web" / "static"
