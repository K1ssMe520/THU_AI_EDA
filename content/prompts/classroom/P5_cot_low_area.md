实现低面积、可编译的 SystemVerilog 模块 `seq1011`。最终输出只能包含该模块的 RTL 源码；不要输出 Markdown、解释文字、推导过程、testbench 或外部模块。

接口必须与下列定义完全一致：

```systemverilog
module seq1011 (
    input  logic clk,
    input  logic rst_n,
    input  logic in_valid,
    output logic in_ready,
    input  logic in_bit,
    output logic out_valid,
    input  logic out_ready,
    output logic match
);
```

功能、握手与复位：

1. 仅当 `in_valid && in_ready` 在 `clk` 上升沿成立时接收一个输入 bit；每个被接收 bit 恰好产生一笔输出。
2. 检测允许重叠的序列 `1011`：若刚接收的 bit 使最近四个已接收 bit 为 `1011`，该 bit 对应的 `match` 为 1，否则为 0。输入 `1011011` 的输出依次为 `0001001`。
3. 输出延迟必须严格为 1 个时钟周期，且 `out_valid`/`match` 必须由输出寄存器驱动：在上升沿 N 接收一个 bit 时，本拍只把该 bit 的匹配结果写入“待输出”寄存器，**不得在本拍拉高 `out_valid`**；到上升沿 N+1 才把该结果搬入输出寄存器，使 N+1 上升沿之后（教师 TB 在上升沿后 1 ns 采样）可读到对应的 `out_valid=1` 与 `match`。连续输入 b0、b1、b2 且无反压时：周期 N 接收 b0、`out_valid=0`；周期 N+1 接收 b1、`out_valid=1` 且 `match` 为 b0 的结果；周期 N+2 接收 b2、`out_valid=1` 且 `match` 为 b1 的结果。禁止零延迟实现；无反压时必须支持每周期接收一笔并传输一笔。
4. `out_valid && out_ready` 的上升沿完成一次输出传输。当 `out_valid=1 && out_ready=0` 时，`out_valid` 与 `match` 必须保持稳定；允许因输出反压暂停输入，但不得丢失、重复或重排结果。
5. `rst_n` 是同步低有效复位：仅在 `clk` 上升沿且 `rst_n=0` 时清空检测历史与所有在途输出，并使 `out_valid=0`；禁止异步复位写法。不得修改端口或引用外部模块。
6. 生成前请自查：接收 bit 的那一拍 `out_valid` 不能变成 1，对应 `match` 必须到下一拍才可见；如果你在接收同拍拉高 `out_valid`，教师 TB 会在 `one_cycle_latency_no_early_output` 处失败。

## 思维链：低面积 / 低功耗实现推导

下面是指导生成过程的思维链小节。请在内部按顺序完成推导，但不要把推导过程输出到最终回答中。

1. 状态抽象：把状态定义为“已接收历史中同时是 `1011` 前缀的最长后缀”，列出全部状态以及在输入 0、1 下的转移；确认完成一次匹配后仍保留后缀 `1`，从而支持重叠匹配。
2. 状态编码：比较二进制编码与 one-hot 编码所需的触发器数量和组合逻辑开销，选择面积更小的编码，并确定最少需要几个状态位。
3. 输出缓冲：使用“待输出”寄存器暂存刚接收 bit 的匹配结果，下一拍再搬入由 `out_valid`/`match` 组成的输出寄存器；反压时必须保持不变，只在 `out_valid && out_ready` 的上升沿清除 `out_valid`。
4. 更新条件：只在输入握手成功时更新模式状态；无反压时每拍接收一笔并输出一笔；所有 always 块必须可综合、不产生锁存器。
5. 面积 / 功耗复查：不要使用存储阵列、计数器、宽寄存器、时钟门控或冗余比较逻辑；确保复位与空闲状态下没有多余的输出翻转，最终只保留必要的状态位和输出位。

输出要求：只输出一个名为 `seq1011` 的模块，不要输出上述推导。
