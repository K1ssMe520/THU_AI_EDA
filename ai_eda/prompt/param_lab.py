"""大模型 API 参数教学实验：max_tokens、temperature 与 reasoning_effort。

页面上的「API 参数」面板只允许调用这里预先登记的演示题目；调用参数仍由
前端传入并在此校验，避免把任意 Prompt 或文件读入接口暴露给浏览器。
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from ai_eda.model.client import ModelClient

# 参数实验需要模型按题面直接回答，因此使用课程助教系统提示，而不是
# Prompt 实验里“只输出 RTL”的单次生成系统提示。
SYSTEM_PROMPT = (
    "你是《人工智能辅助数字集成电路》课程的助教，精通数字电路与 SystemVerilog。"
    "请用中文回答，严格遵守用户给出的输出格式与篇幅要求；不要输出与题目无关的内容。"
)

MAX_TOKENS_QUESTION = """请完成一道数字电路设计题，严格按下面三部分输出，不要省略任何内容：

1. 设计说明：用约 200 字说明同步 FIFO（深度 16、位宽 8、单时钟、同步低有效复位）的实现要点，包括读写指针、空/满判断、写满保护与读空保护。

2. SystemVerilog RTL：给出完整、可编译的模块 fifo16x8，端口为 clk、rst_n、wr_en、rd_en、din、dout、full、empty。要求包含存储阵列、指针逻辑、full/empty 组合判断和同步复位，所有 always 块必须闭合，最后一行必须是 endmodule，不得用省略号代替任何代码。

3. 测试向量：给出 6 组读写操作序列，并用表格列出每组操作前后的 full、empty、dout 预期值。"""

TEMPERATURE_QUESTION = """这是一道数字电路设计决策题：为 8 位无符号乘法器选择一种实现架构（阵列乘法器 / Wallace 树 / Booth 编码）。

要求：
1. 只选择其中一种架构，用不超过 100 字说明选择理由，比较面积、关键路径延迟、功耗和可综合性。
2. 给出该架构对应的关键 SystemVerilog 代码片段（不超过 15 行），不要求完整模块。
3. 最后一行固定写成：选择=<阵列乘法器|Wallace 树|Booth 编码>"""

REASONING_QUESTION = """某同步数字电路包含两条寄存器到寄存器的时序路径，均由同一时钟驱动，时钟周期 T = 8 ns。

路径 A：
- launch 触发器 clk-to-q 最大 0.40 ns、最小 0.15 ns；
- 组合逻辑最大延迟 5.60 ns、最小延迟 1.20 ns；
- capture 触发器 setup 时间 0.25 ns、hold 时间 0.10 ns。

路径 B：
- launch 触发器 clk-to-q 最大 0.50 ns、最小 0.20 ns；
- 组合逻辑最大延迟 4.20 ns、最小延迟 0.80 ns；
- capture 触发器 setup 时间 0.25 ns、hold 时间 0.10 ns。

时钟偏斜为 +0.35 ns（capture 时钟相对 launch 时钟晚到）。

请分别计算：
1. 路径 A 与路径 B 的 setup slack；
2. 路径 A 与路径 B 的 hold slack；
3. 该电路能正常工作的最高时钟频率（MHz，保留两位小数，假设 hold 均满足）。

要求写出 setup 与 hold 的时序不等式和代入过程；最后一行固定写成：答案=<A_setup>/<A_hold>/<B_setup>/<B_hold>/<fmax>，例如：答案=1.00/2.00/3.00/4.00/123.45"""


# 每道演示题只登记一次；前端通过 GET /api/param-lab 读取完整定义。
DEMOS: tuple[dict[str, Any], ...] = (
    {
        "id": "max_tokens",
        "index": 1,
        "title": "MAX TOKENS · 输出预算决定回答是否完整",
        "parameter": "max_tokens",
        "summary": (
            "同一道 FIFO 设计题：max_tokens=512 时回答会在 RTL 或测试向量中途被截断，"
            "finish_reason 为 length；提高到 4096 才能拿到完整模块。"
        ),
        "hint": "观察 finish_reason 与回答中是否出现 endmodule；completion_tokens 会贴近 max_tokens。",
        "question": MAX_TOKENS_QUESTION,
        "presets": [
            {
                "key": "512",
                "label": "max_tokens = 512",
                "settings": {
                    "max_tokens": 512,
                    "temperature": 0.2,
                    "thinking": False,
                    "reasoning_effort": "high",
                },
            },
            {
                "key": "4096",
                "label": "max_tokens = 4096",
                "settings": {
                    "max_tokens": 4096,
                    "temperature": 0.2,
                    "thinking": False,
                    "reasoning_effort": "high",
                },
            },
        ],
        "check": "complete_module",
        "expected_answer": None,
    },
    {
        "id": "temperature",
        "index": 2,
        "title": "TEMPERATURE · 采样随机性与方案多样性",
        "parameter": "temperature",
        "summary": (
            "同一道 8 位乘法器架构选择题各运行两次：低温 0.0 的两次回答高度一致；"
            "高温 1.4 更容易出现不同的架构选择与表述，两次回答差异明显。"
        ),
        "hint": "temperature 只在关闭 thinking 时有效；开启思考后服务端会忽略该参数。",
        "question": TEMPERATURE_QUESTION,
        "presets": [
            {
                "key": "low",
                "label": "温度 0.0 · 连续运行两次",
                "runs": 2,
                "settings": {
                    "max_tokens": 1024,
                    "temperature": 0.0,
                    "thinking": False,
                    "reasoning_effort": "high",
                },
            },
            {
                "key": "high",
                "label": "温度 1.4 · 连续运行两次",
                "runs": 2,
                "settings": {
                    "max_tokens": 1024,
                    "temperature": 1.4,
                    "thinking": False,
                    "reasoning_effort": "high",
                },
            },
        ],
        "check": "similarity",
        "expected_answer": None,
    },
    {
        "id": "reasoning",
        "index": 3,
        "title": "REASONING EFFORT · 思维强度与推导质量",
        "parameter": "reasoning_effort",
        "summary": (
            "同一道双路径 setup/hold 时序分析题：low 常在最大/最小延迟、时钟偏斜方向和路径选择上出错；"
            "high / max 更愿意逐步列出两组不等式，更容易命中参考答案。"
        ),
        "hint": (
            "参考答案：A_setup=2.10 ns、A_hold=0.90 ns、B_setup=3.40 ns、B_hold=0.55 ns、fmax=169.49 MHz。"
            "低思维强度常见错误：hold 用最大延迟、时钟偏斜符号写反、漏算其中一条路径。"
        ),
        "question": REASONING_QUESTION,
        "presets": [
            {
                "key": "low",
                "label": "reasoning_effort = low",
                "settings": {
                    "max_tokens": 8192,
                    "temperature": 0.2,
                    "thinking": True,
                    "reasoning_effort": "low",
                },
            },
            {
                "key": "high",
                "label": "reasoning_effort = high",
                "settings": {
                    "max_tokens": 8192,
                    "temperature": 0.2,
                    "thinking": True,
                    "reasoning_effort": "high",
                },
            },
            {
                "key": "max",
                "label": "reasoning_effort = max",
                "settings": {
                    "max_tokens": 8192,
                    "temperature": 0.2,
                    "thinking": True,
                    "reasoning_effort": "max",
                },
            },
        ],
        "check": "expected_answer",
        "expected_answer": "A_setup=2.10 ns · A_hold=0.90 ns · B_setup=3.40 ns · B_hold=0.55 ns · fmax=169.49 MHz",
        "expected_values": [2.10, 0.90, 3.40, 0.55, 169.49],
        "expected_labels": ["A_setup", "A_hold", "B_setup", "B_hold", "fmax"],
        "answer_format": "答案=<A_setup>/<A_hold>/<B_setup>/<B_hold>/<fmax>",
    },
)

_DEMOS_BY_ID = {demo["id"]: demo for demo in DEMOS}


def describe() -> dict[str, Any]:
    """返回前端渲染参数面板所需的全部公开信息。"""
    return {
        "model": ModelClient.MODEL_NAME,
        "base_url": ModelClient.BASE_URL,
        "system_prompt": SYSTEM_PROMPT,
        "demos": [dict(demo) for demo in DEMOS],
    }


def _require_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} 必须是数字")
    return float(value)


def validate_settings(request: dict[str, Any]) -> dict[str, Any]:
    """校验前端传来的单次调用参数，并补齐默认值。"""
    max_tokens = request.get("max_tokens", 4096)
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int):
        raise ValueError("max_tokens 必须是整数")
    if not 64 <= max_tokens <= 8192:
        raise ValueError("max_tokens 必须在 64 到 8192 之间")

    temperature = _require_number(request.get("temperature", 0.2), "temperature")
    if not 0 <= temperature <= 2:
        raise ValueError("temperature 必须在 0 到 2 之间")

    thinking = request.get("thinking", False)
    if not isinstance(thinking, bool):
        raise ValueError("thinking 必须是布尔值")

    reasoning_effort = request.get("reasoning_effort", "high")
    if reasoning_effort not in {"low", "high", "max"}:
        raise ValueError("reasoning_effort 无效")

    return {
        "max_tokens": max_tokens,
        "temperature": temperature,
        "thinking": thinking,
        "reasoning_effort": reasoning_effort,
    }


def run_demo(demo_id: str, request: dict[str, Any]) -> dict[str, Any]:
    """按指定参数运行一道预登记的参数演示题，单次调用、不落盘。"""
    demo = _DEMOS_BY_ID.get(demo_id)
    if demo is None:
        raise ValueError("未知的参数实验")
    settings = validate_settings(request)

    started = time.perf_counter()
    client = ModelClient(**settings)
    detail = client.generate_once_detail(demo["question"], SYSTEM_PROMPT)
    duration_ms = round((time.perf_counter() - started) * 1000, 1)

    return {
        "demo_id": demo_id,
        "settings": settings,
        "answer": detail.get("answer") or "",
        "reasoning": detail.get("reasoning"),
        "usage": detail.get("usage"),
        "finish_reason": detail.get("finish_reason"),
        "duration_ms": duration_ms,
        "model": ModelClient.MODEL_NAME,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
    }
