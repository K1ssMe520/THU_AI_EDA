`timescale 1ns/1ps

// 仅用于功耗活动采样，不承担功能验收。
module tb_power_agent_rise_edge;
  logic clk = 0;
  logic rst_n = 0;
  logic signal = 0;
  logic pulse;
  string vcd_path;

  rise_edge dut (.*);
  always #5 clk = ~clk;

  initial begin
    if (!$value$plusargs("vcd=%s", vcd_path)) vcd_path = "activity.vcd";
    $dumpfile(vcd_path);
    $dumpvars(0, dut);
    repeat (2) @(posedge clk);
    @(negedge clk) rst_n = 1;
    // 低保持、高保持及反复上升沿，覆盖状态寄存器与输出翻转。
    @(negedge clk) signal = 1; @(negedge clk) signal = 1;
    @(negedge clk) signal = 0; @(negedge clk) signal = 1;
    @(negedge clk) signal = 0; @(negedge clk) signal = 1;
    repeat (3) @(posedge clk);
    $finish;
  end
endmodule
