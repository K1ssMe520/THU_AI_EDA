`timescale 1ns/1ps

// 仅用于功耗活动采样，不承担功能验收。
module tb_power_classroom_seq1011;
  logic clk = 0;
  logic rst_n = 0;
  logic in_valid = 0;
  logic in_ready;
  logic in_bit = 0;
  logic out_valid;
  logic out_ready = 1;
  logic match;
  string vcd_path;

  seq1011 dut (.*);
  always #5 clk = ~clk;

  task automatic send_bit(input logic bit_value, input logic ready_value);
    integer guard;
    begin
      @(negedge clk);
      out_ready = ready_value;
      in_valid = 1;
      in_bit = bit_value;
      // 允许设计在反压时暂停接收；最多等 32 拍，避免功耗采样卡死。
      guard = 0;
      @(posedge clk);
      while (!in_ready && guard < 32) begin
        @(posedge clk);
        guard = guard + 1;
      end
      @(negedge clk);
      in_valid = 0;
    end
  endtask

  initial begin
    if (!$value$plusargs("vcd=%s", vcd_path)) vcd_path = "activity.vcd";
    $dumpfile(vcd_path);
    $dumpvars(0, dut);
    repeat (2) @(posedge clk);
    @(negedge clk) rst_n = 1;
    // 连续吞吐、重叠命中、输出反压和恢复四类活动。
    send_bit(1'b1, 1'b1); send_bit(1'b0, 1'b1); send_bit(1'b1, 1'b1); send_bit(1'b1, 1'b1);
    send_bit(1'b0, 1'b0); repeat (3) @(posedge clk); out_ready = 1;
    send_bit(1'b0, 1'b1); send_bit(1'b1, 1'b1); send_bit(1'b1, 1'b1);
    repeat (4) @(posedge clk);
    $finish;
  end
endmodule
