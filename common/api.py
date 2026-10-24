"""DeepSeek 模型调用封装。"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterator
from typing import Any, Literal

from openai import OpenAI


# Prompt 实验研究“如何写 Prompt”，系统提示保持中性，不在系统层替用户约束输出格式；
# 这样 P1 的口头需求与 P2 之后的结构化 Prompt 才有可观察的差别。
DEFAULT_SYSTEM_PROMPT = (
    "You are a digital IC design engineer. Follow the user's instructions."
)

# Agent 的模型节点只负责生成 RTL，因此使用更严格的系统提示。
RTL_SYSTEM_PROMPT = (
    "You are a digital IC engineer. Follow the user specification exactly. "
    "Return only the requested RTL source code, without Markdown fences or explanation."
)


class ModelClient:
    """课程实验共用的 DeepSeek 单模型客户端。"""

    # 当前课程默认使用 Flash：速度快、成本低，适合 Prompt 实验的重复采样。
    MODEL_NAME = "deepseek-flash"
    BASE_URL = "https://api.deepseek.com"

    # 如需更强的复杂 RTL / Agent 推理能力，可将上一行改为：
    # MODEL_NAME = "deepseek-v4-pro"

    def __init__(
        self,
        temperature: float = 0.2,
        max_tokens: int = 4096,
        thinking: bool = False,
        reasoning_effort: Literal["low", "high", "max"] = "high",
    ) -> None:
        """创建客户端；温度和最大输出长度由调用者传入。"""
        if not 0 <= temperature <= 2:
            raise ValueError("temperature 必须在 0 到 2 之间。")
        if max_tokens <= 0:
            raise ValueError("max_tokens 必须为正整数。")

        # 推荐将 key 写入系统环境变量：export DEEPSEEK_API_KEY='...'
        api_key = os.getenv("DEEPSEEK_API_KEY")
        # 兼容本项目早期使用的环境变量，课程迁移完成后可删除这一行。
        api_key = api_key or os.getenv("DSV3_KEY") or os.getenv("LLM_API_KEY")
        # 若仅用于个人本地调试，也可以直接把自己的 key 写在下一行：
        # api_key = "sk-请替换为你自己的DeepSeekKey"
        if not api_key:
            raise RuntimeError("未找到 API key。请设置环境变量 DEEPSEEK_API_KEY。")

        self.temperature = temperature
        self.max_tokens = max_tokens
        self.thinking = thinking
        self.reasoning_effort = reasoning_effort
        self.client = OpenAI(api_key=api_key, base_url=self.BASE_URL)

    def _complete(self, messages: list[dict[str, str]]) -> str:
        """向 DeepSeek 发送完整消息历史并取回最终文本。"""
        return self._complete_detail(messages)["answer"]

    # 服务端偶发返回空 content 时允许自动重试的次数；max_tokens 截断不会重试。
    EMPTY_CONTENT_RETRIES = 1

    def _empty_content_error(
        self,
        finish_reason: str | None,
        reasoning: str | None,
        usage: dict[str, Any] | None,
        attempts: int,
    ) -> RuntimeError:
        """把空回答整理成可操作的错误信息，便于区分截断与偶发空响应。"""
        details: list[str] = []
        if finish_reason == "length":
            details.append("finish_reason=length，输出预算被耗尽")
        elif finish_reason:
            details.append(f"finish_reason={finish_reason}")
        if reasoning:
            details.append("服务端返回了思维链但没有最终回答")
        if usage and usage.get("completion_tokens") is not None:
            details.append(f"completion_tokens={usage['completion_tokens']}")
        details.append(f"max_tokens={self.max_tokens}")
        details.append(f"已尝试 {attempts} 次")
        if self.thinking:
            details.append(f"thinking=enabled，reasoning_effort={self.reasoning_effort}")
        if finish_reason == "length":
            suggestion = (
                "思考模式和长 RTL 都会消耗输出预算：请提高 max_tokens（如 8192/16384），"
                "或在只需要 RTL 时关闭 thinking 后重试。"
            )
        else:
            suggestion = "这是服务端偶发空响应，可稍后重试；若持续出现，请检查模型服务状态或换用更长的 max_tokens。"
        return RuntimeError("模型没有返回最终文本内容（" + "；".join(details) + "）。" + suggestion)

    def _complete_detail(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        """返回最终回答、可选推理文本及 token 用量。

        空 content 可能来自透明错误、网络抖动，也可能是 thinking 模式耗尽了
        max_tokens。对于非截断的空响应自动重试一次；仍为空时给出带诊断信息的
        错误，避免所有原因都显示成同一句“模型没有返回文本内容”。
        """
        request = {
            "model": self.MODEL_NAME,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "stream": False,
            # DeepSeek 默认开启思考；这里显式指定，保证实验设置可复现。
            "extra_body": {
                "thinking": {"type": "enabled" if self.thinking else "disabled"}
            },
        }

        if self.thinking:
            # 思考模式下 temperature 会被服务端忽略，因此不发送它。
            request["reasoning_effort"] = self.reasoning_effort
        else:
            # 非思考模式下 temperature 有效，适合控制 RTL 采样的随机性。
            request["temperature"] = self.temperature

        attempts = 0
        while True:
            attempts += 1
            completion = self.client.chat.completions.create(**request)
            choice = completion.choices[0]
            message = choice.message
            content = message.content if isinstance(message.content, str) else ""
            finish_reason = getattr(choice, "finish_reason", None)
            reasoning = getattr(message, "reasoning_content", None)
            if not reasoning:
                reasoning = getattr(message, "reasoning", None)
            usage = getattr(completion, "usage", None)
            usage_payload = (
                {
                    "prompt_tokens": getattr(usage, "prompt_tokens", None),
                    "completion_tokens": getattr(usage, "completion_tokens", None),
                    "total_tokens": getattr(usage, "total_tokens", None),
                }
                if usage is not None
                else None
            )
            if content.strip():
                return {
                    "answer": content,
                    "reasoning": reasoning,
                    "usage": usage_payload,
                    # "stop" 表示正常结束；"length" 表示触达 max_tokens 被截断。
                    "finish_reason": finish_reason,
                }
            # 已被 max_tokens 截断时，重复同一请求只会再次被截断，直接报错。
            if finish_reason == "length" or attempts > self.EMPTY_CONTENT_RETRIES:
                raise self._empty_content_error(
                    finish_reason, reasoning, usage_payload, attempts
                )
            time.sleep(0.8)

    def stream_once_detail(
        self, prompt: str, system_prompt: str = DEFAULT_SYSTEM_PROMPT
    ) -> Iterator[dict[str, Any]]:
        """流式生成：逐块产出 reasoning / answer 增量，最后产出 done。

        消费方（工作台）负责把增量推送给浏览器；若服务端只返回思维链、
        最终回答为空，则用与普通调用一致的诊断错误结束。
        """
        messages = self.new_conversation(system_prompt)
        messages.append({"role": "user", "content": prompt})
        request = {
            "model": self.MODEL_NAME,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "stream": True,
            "extra_body": {
                "thinking": {"type": "enabled" if self.thinking else "disabled"}
            },
        }
        if self.thinking:
            request["reasoning_effort"] = self.reasoning_effort
        else:
            request["temperature"] = self.temperature

        answer_parts: list[str] = []
        reasoning_parts: list[str] = []
        usage_payload: dict[str, Any] | None = None
        finish_reason: str | None = None
        completion = self.client.chat.completions.create(**request)
        for chunk in completion:
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                usage_payload = {
                    "prompt_tokens": getattr(usage, "prompt_tokens", None),
                    "completion_tokens": getattr(usage, "completion_tokens", None),
                    "total_tokens": getattr(usage, "total_tokens", None),
                }
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            choice = choices[0]
            finish_reason = getattr(choice, "finish_reason", None) or finish_reason
            delta = getattr(choice, "delta", None)
            if delta is None:
                continue
            reasoning_delta = getattr(delta, "reasoning_content", None)
            if not reasoning_delta:
                reasoning_delta = getattr(delta, "reasoning", None)
            if isinstance(reasoning_delta, str) and reasoning_delta:
                reasoning_parts.append(reasoning_delta)
                yield {"type": "reasoning", "text": reasoning_delta}
            content_delta = getattr(delta, "content", None)
            if isinstance(content_delta, str) and content_delta:
                answer_parts.append(content_delta)
                yield {"type": "answer", "text": content_delta}

        answer = "".join(answer_parts)
        reasoning = "".join(reasoning_parts) or None
        if not answer.strip():
            raise self._empty_content_error(finish_reason, reasoning, usage_payload, 1)
        yield {
            "type": "done",
            "answer": answer,
            "reasoning": reasoning,
            "usage": usage_payload,
            "finish_reason": finish_reason,
        }

    def new_conversation(
        self, system_prompt: str = DEFAULT_SYSTEM_PROMPT
    ) -> list[dict[str, str]]:
        """创建一段可由调用者保存和传回的多轮对话历史。"""
        return [{"role": "system", "content": system_prompt}]

    def chat(self, messages: list[dict[str, str]], user_prompt: str) -> str:
        """在既有历史上追加一轮用户输入和模型回答。"""
        messages.append({"role": "user", "content": user_prompt})
        content = self._complete(messages)
        messages.append({"role": "assistant", "content": content})
        return content

    def generate_once(self, prompt: str, system_prompt: str = DEFAULT_SYSTEM_PROMPT) -> str:
        """单次生成的便捷入口：新建历史、调用一次、然后丢弃历史。"""
        return self.chat(self.new_conversation(system_prompt), prompt)

    def generate_once_detail(
        self, prompt: str, system_prompt: str = DEFAULT_SYSTEM_PROMPT
    ) -> dict[str, Any]:
        """单次生成并保留可展示的推理文本（若服务端返回）。"""
        messages = self.new_conversation(system_prompt)
        messages.append({"role": "user", "content": prompt})
        return self._complete_detail(messages)

    def generate_with_tools(
        self,
        prompt: str,
        system_prompt: str,
        tools: list[dict[str, Any]],
        tool_executor: Any,
        max_rounds: int = 6,
    ) -> dict[str, Any]:
        """带原生 function calling 的生成循环。

        模型可以调用 ``tools`` 中声明的函数；每次调用由 ``tool_executor(name, args)``
        执行，并把 JSON 结果作为 tool message 回填，直到模型给出最终文本。
        返回最终 answer、reasoning、累计 usage，以及可展示的 tool_calls 记录。
        """
        if not tools:
            return self.generate_once_detail(prompt, system_prompt)
        messages: list[dict[str, Any]] = self.new_conversation(system_prompt)
        messages.append({"role": "user", "content": prompt})

        request: dict[str, Any] = {
            "model": self.MODEL_NAME,
            "max_tokens": self.max_tokens,
            "stream": False,
            "extra_body": {
                "thinking": {"type": "enabled" if self.thinking else "disabled"}
            },
            "tools": tools,
            "tool_choice": "auto",
        }
        if self.thinking:
            request["reasoning_effort"] = self.reasoning_effort
        else:
            request["temperature"] = self.temperature

        usage_total = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        reasoning_parts: list[str] = []
        tool_log: list[dict[str, Any]] = []

        for _ in range(max_rounds):
            request["messages"] = messages
            completion = self.client.chat.completions.create(**request)
            choice = completion.choices[0]
            message = choice.message
            usage = getattr(completion, "usage", None)
            if usage is not None:
                for key in usage_total:
                    value = getattr(usage, key, None)
                    if isinstance(value, (int, float)):
                        usage_total[key] += value
            content = message.content if isinstance(message.content, str) else ""
            reasoning = getattr(message, "reasoning_content", None) or getattr(
                message, "reasoning", None
            )
            if reasoning:
                reasoning_parts.append(str(reasoning))

            tool_calls = list(getattr(message, "tool_calls", None) or [])
            if tool_calls:
                assistant_calls: list[dict[str, Any]] = []
                parsed_calls: list[tuple[Any, str, str, dict[str, Any]]] = []
                for call in tool_calls:
                    function = getattr(call, "function", None)
                    name = getattr(function, "name", "") if function else ""
                    raw_arguments = getattr(function, "arguments", "") if function else ""
                    try:
                        arguments = json.loads(raw_arguments or "{}")
                    except json.JSONDecodeError:
                        arguments = {}
                    if not isinstance(arguments, dict):
                        arguments = {}
                    assistant_calls.append(
                        {
                            "id": getattr(call, "id", ""),
                            "type": "function",
                            "function": {"name": name, "arguments": raw_arguments or "{}"},
                        }
                    )
                    parsed_calls.append((call, name, raw_arguments or "{}", arguments))
                messages.append(
                    {
                        "role": "assistant",
                        "content": content or "",
                        "tool_calls": assistant_calls,
                    }
                )
                for call, name, _raw_arguments, arguments in parsed_calls:
                    result = tool_executor(name, arguments)
                    result_text = json.dumps(result, ensure_ascii=False)
                    if len(result_text) > 60_000:
                        result_text = result_text[:60_000] + "…(结果截断)"
                    display_arguments = {
                        key: (
                            f"{value[:400]}…（{len(value)} 字符）"
                            if isinstance(value, str) and len(value) > 400
                            else value
                        )
                        for key, value in arguments.items()
                    }
                    tool_log.append(
                        {
                            "name": name,
                            "arguments": display_arguments,
                            "result": result,
                        }
                    )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": getattr(call, "id", ""),
                            "content": result_text,
                        }
                    )
                continue

            if content.strip():
                return {
                    "answer": content,
                    "reasoning": "\n\n".join(reasoning_parts) or None,
                    "usage": usage_total,
                    "finish_reason": getattr(choice, "finish_reason", None),
                    "tool_calls": tool_log,
                }
            raise self._empty_content_error(
                getattr(choice, "finish_reason", None),
                reasoning,
                usage_total,
                1,
            )

        raise RuntimeError("模型连续调用工具超过上限，未能给出最终回答。")
