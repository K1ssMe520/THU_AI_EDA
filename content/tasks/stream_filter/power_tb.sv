`timescale 1ns/1ps

// 仅用于功耗活动采样，不承担功能验收。
module tb_power_agent_stream_filter;
  logic        clk = 0;
  logic        rst_n = 0;
  logic        in_valid = 0;
  logic [7:0]  in_data = 0;
  logic        out_ready = 0;
  logic        in_ready;
  logic        out_valid;
  logic [7:0]  out_data;
  logic [15:0] checksum;
  logic [3:0]  count;
  string       vcd_path;
  integer      i;

  stream_filter dut (.*);
  always #5 clk = ~clk;

  initial begin
    if (!$value$plusargs("vcd=%s", vcd_path)) vcd_path = "activity.vcd";
    $dumpfile(vcd_path);
    $dumpvars(0, dut);

    repeat (2) @(posedge clk);
    @(negedge clk) rst_n = 1;

    // Burst fill.
    for (i = 0; i < 8; i = i + 1) begin
      @(negedge clk); in_valid = 1; in_data = 8'h20 + i[7:0];
      @(posedge clk);
      @(negedge clk); in_valid = 0;
    end

    // Drain with alternating backpressure.
    for (i = 0; i < 8; i = i + 1) begin
      @(negedge clk); out_ready = (i % 2 == 0);
      @(posedge clk);
      @(negedge clk); out_ready = 1;
      @(posedge clk);
    end
    @(negedge clk); out_ready = 0;

    // Long mixed activity: alternate write/read with periodic stalls.
    for (i = 0; i < 64; i = i + 1) begin
      @(negedge clk);
      in_valid = 1;
      in_data = 8'hA5 ^ i[7:0];
      out_ready = (i % 3 != 0);
      @(posedge clk);
      @(negedge clk);
      in_valid = 0;
      out_ready = (i % 5 == 0);
      @(posedge clk);
    end

    @(negedge clk); in_valid = 0; out_ready = 1;
    repeat (16) @(posedge clk);
    $finish;
  end
endmodule
