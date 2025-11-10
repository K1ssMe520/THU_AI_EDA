from openai import OpenAI
import os


class DeepSeek_R1:
    ## 如果大家实在不想充钱买，就用这个我自费买的key，但大家一起用肯定会很卡
    key = os.getenv("DSV3_KEY")

    ## 如果大家买了自己的key，就在这里填入自己的key
    # key = 'xxxx'

    client = OpenAI(api_key=key, base_url="https://api.deepseek.com")

    @staticmethod
    def get_answer(request: str, system_prompt: str = None, supplement: str = None, stream: bool = True,
                   is_reason: bool = False, is_print: bool = True, is_multi_round: bool = False, last_message=None):
        if is_multi_round and (last_message is not None):
            # 清理历史消息中的 reasoning_content
            messages = DeepSeek_R1._clean_messages(last_message)
        else:
            messages = []

        # 添加系统提示和补充信息（只在非多轮对话或第一轮时添加）
        if not is_multi_round:
            if system_prompt is not None:
                messages.insert(0, {"role": "system", "content": system_prompt})
            if supplement is not None:
                messages.append({"role": "assistant", "content": supplement})

        messages.append({"role": "user", "content": request})

        if is_reason:
            base_model = "deepseek-reasoner"
        else:
            base_model = "deepseek-chat"

        if stream:
            completion = DeepSeek_R1.client.chat.completions.create(
                model=base_model,
                messages=messages,
                stream=True,
                temperature=0.0,
                # max_tokens=2000,
            )
            response = ""
            reasoning_content = ""  # 存储思维链内容
            reasoning_ended = False  # 新增：标记思维链是否已结束

            for chunk in completion:
                # 检查是否有思维链内容（推理模式特有）
                if is_reason and hasattr(chunk.choices[0].delta, 'reasoning_content') and chunk.choices[
                    0].delta.reasoning_content:
                    reasoning_chunk = chunk.choices[0].delta.reasoning_content
                    reasoning_content += reasoning_chunk
                    if is_print:
                        # 用灰色文字标识思维链
                        print(f"\033[90m{reasoning_chunk}\033[0m", end="", flush=True)

                # 检查思维链是否结束（只执行一次）
                if is_reason and not reasoning_ended and hasattr(chunk.choices[0].delta, 'reasoning_content') and \
                        chunk.choices[0].delta.reasoning_content is None:
                    reasoning_ended = True
                    if is_print and reasoning_content:
                        print("\n--- 推理结束，以下是最终回答 ---\n", end="", flush=True)

                # 检查是否有最终回答内容
                if hasattr(chunk.choices[0].delta, 'content') and chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    if is_print:
                        # 最终回答用正常颜色显示
                        print(content, end="", flush=True)
                    response += content

            # 流式模式下，手动构建assistant的消息
            assistant_message = {
                "role": "assistant",
                "content": response
            }
            # 如果是推理模式且获取到了推理内容，也添加到消息中（仅用于本地存储）
            if is_reason and reasoning_content:
                assistant_message["reasoning_content"] = reasoning_content

        else:
            completion = DeepSeek_R1.client.chat.completions.create(
                model=base_model,
                messages=messages,
                stream=False,
                temperature=0.0,
                # max_tokens=2000,
            )

            if is_reason:
                # 非流式模式下，思维链和最终回答分开返回
                reasoning_content = getattr(completion.choices[0].message, 'reasoning_content', '')
                response = completion.choices[0].message.content

                if is_print:
                    if reasoning_content:
                        print("\033[90m" + "思考过程：" + "\033[0m")
                        print("\033[90m" + reasoning_content + "\033[0m")
                        print("\n--- 推理结束，以下是最终回答 ---\n")
                    print(response)
            else:
                response = completion.choices[0].message.content
                if is_print:
                    print(response)

            # 非流式模式下，直接使用API返回的消息
            assistant_message = {
                "role": completion.choices[0].message.role,
                "content": completion.choices[0].message.content
            }
            # 如果是推理模式且获取到了推理内容，也添加到消息中（仅用于本地存储）
            if is_reason and hasattr(completion.choices[0].message, 'reasoning_content'):
                assistant_message["reasoning_content"] = completion.choices[0].message.reasoning_content

        if is_multi_round:
            messages.append(assistant_message)
            return messages, response
        else:
            return response

    @staticmethod
    def _clean_messages(messages):
        """清理消息中的 reasoning_content 字段，确保发送给 API 的消息是干净的"""
        cleaned_messages = []
        for msg in messages:
            cleaned_msg = {
                "role": msg["role"],
                "content": msg["content"]
            }
            cleaned_messages.append(cleaned_msg)
        return cleaned_messages