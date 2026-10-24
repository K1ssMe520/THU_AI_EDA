实现 SystemVerilog 模块 `seq1011`。只输出该模块的 RTL 源码；不要输出 Markdown、解释文字、testbench 或其他模块。

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

功能：检测输入 bit 流中允许重叠的序列 `1011`，检测到匹配时通过 `match` 输出结果。
