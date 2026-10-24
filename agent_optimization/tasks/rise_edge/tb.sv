`timescale 1ns/1ps

module tb_agent_rise_edge;
  logic clk = 0;
  logic rst_n = 0;
  logic signal;
  logic pulse;
  integer failures = 0;
  integer cycle = 0;

  rise_edge dut (.*);
  always #5 clk = ~clk;
  always @(posedge clk) cycle <= cycle + 1;

  task automatic check(input logic want, input string name);
    begin
      #1;
      $display("AI_EDA_TRACE|cycle=%0d|case=rise_edge|event=%s|signal=%b|pulse=%b|expected_pulse=%b", cycle, name, signal, pulse, want);
      if (pulse !== want) begin
        failures = failures + 1;
        $display("CHECK: %s — expected pulse=%b got=%b", name, want, pulse);
      end
    end
  endtask

  initial begin
    signal = 0;
    repeat (2) @(posedge clk);
    check(1'b0, "reset");
    @(negedge clk); rst_n = 1; signal = 0;
    @(posedge clk); check(1'b0, "idle_low");
    @(negedge clk); signal = 1;
    @(posedge clk); check(1'b1, "rising_edge");
    @(posedge clk); check(1'b0, "held_high");
    @(negedge clk); signal = 0;
    @(posedge clk); check(1'b0, "falling_edge");
    @(negedge clk); signal = 1;
    @(posedge clk); check(1'b1, "second_rising_edge");
    @(negedge clk); rst_n = 0;
    @(posedge clk); check(1'b0, "synchronous_reset");
    if (failures == 0) $display("LAB_RESULT: PASS");
    else begin $display("LAB_RESULT: FAIL (%0d checks)", failures); $fatal(1); end
    $finish;
  end
endmodule
