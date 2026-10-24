# 简易 Agent 任务：同步上升沿脉冲检测器

实现唯一 SystemVerilog 模块 `rise_edge`：

```systemverilog
module rise_edge (
    input  logic clk,
    input  logic rst_n,
    input  logic signal,
    output logic pulse
);
```

在每个 `clk` 上升沿后：若当前采样到 `signal=1`，且上一拍采样值为 0，则 `pulse=1`；其他情况 `pulse=0`。`rst_n=0` 是同步低有效复位，复位后历史采样值和 `pulse` 都为 0。

仅输出一个名为 `rise_edge` 的 RTL 模块。
