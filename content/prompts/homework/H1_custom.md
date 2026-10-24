请用 SystemVerilog 写一个单模块 AES-128 加密核，模块名和端口必须完全如下：

module aes128 (
    input  logic         clk,
    input  logic         rst_n,
    input  logic         start,
    input  logic [127:0] key,
    input  logic [127:0] plaintext,
    output logic         ready,
    output logic         done,
    output logic [127:0] ciphertext
);

要求：
1. 只允许一个 module，不得例化任何其他模块，不得 include、$readmemh、DPI、IP 或外部文件；function/task/generate/多个 always 可用。
2. 实现标准 AES-128 加密，10 轮，符合 FIPS-197；只加密不解密。
3. rst_n 为同步低有效复位；复位后 ready=1、done=0。ready=1 表示空闲。start && ready 在 clk 上升沿成立时采样 key 和 plaintext 并开始加密，随后 ready 拉低。
4. 加密完成后 done 拉高且恰好持续一个时钟周期，同时 ciphertext 有效；之后 ready 恢复为 1。从接收 start 到 done 不超过 200 个时钟周期。
5. 支持连续处理多组数据，每次新任务都重新采样 key 和 plaintext，不得复用上一组结果。
6. 不得硬编码公开测试向量。公开向量 key=000102030405060708090a0b0c0d0e0f, plaintext=00112233445566778899aabbccddeeff, ciphertext=69c4e0d86a7b0430d8cdb78070b4c55a 仅用于自检。
7. 注意 Yosys 兼容：函数内部不要使用 SystemVerilog 的 return，改用 Verilog-2005 风格在函数体内给函数名赋值。
8. 请直接输出完整可综合 SystemVerilog 代码，不要输出解释。