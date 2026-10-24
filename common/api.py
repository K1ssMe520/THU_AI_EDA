"""DeepSeek 模型调用封装。"""

from __future__ import annotations

import os
from typing import Literal

from openai import OpenAI


DEFAULT_SYSTEM_PROMPT = (
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

    def _complete_detail(self, messages: list[dict[str, str]]) -> dict[str, str | None]:
        """返回最终回答及服务端可选提供的推理文本。"""
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

        completion = self.client.chat.completions.create(**request)
        message = completion.choices[0].message
        content = message.content
        if not content:
            raise RuntimeError("模型没有返回文本内容。")
        reasoning = getattr(message, "reasoning_content", None)
        if not reasoning:
            reasoning = getattr(message, "reasoning", None)
        return {"answer": content, "reasoning": reasoning}

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
    ) -> dict[str, str | None]:
        """单次生成并保留可展示的推理文本（若服务端返回）。"""
        messages = self.new_conversation(system_prompt)
        messages.append({"role": "user", "content": prompt})
        return self._complete_detail(messages)
