`timescale 1ns/1ps

module tb_classroom_seq1011;
  logic clk = 0;
  logic rst_n = 0;
  logic in_valid;
  logic in_ready;
  logic in_bit;
  logic out_valid;
  logic out_ready;
  logic match;
  integer failures = 0;
  logic held_match;
  logic bits [0:6];
  logic expected [0:6];
  integer index;
  integer cycle_count = 0;

  seq1011 dut (.*);
  always #5 clk = ~clk;
  always @(posedge clk) cycle_count <= cycle_count + 1;

  task automatic fail(input string name, input string detail);
    begin
      failures = failures + 1;
      $display("CHECK: %s — %s", name, detail);
    end
  endtask

  task automatic expect_no_output(input string name);
    begin
      if (out_valid !== 1'b0)
        fail(name, $sformatf("expected out_valid=0, got %b", out_valid));
    end
  endtask

  task automatic expect_output(input logic want, input string name);
    begin
      if (out_valid !== 1'b1)
        fail(name, $sformatf("expected out_valid=1, got %b", out_valid));
      else if (match !== want)
        fail(name, $sformatf("expected match=%b, got %b", want, match));
    end
  endtask

  task automatic expect_ready(input string name);
    begin
      if (in_ready !== 1'b1)
        fail(name, $sformatf("expected in_ready=1 without backpressure, got %b", in_ready));
    end
  endtask

  task automatic emit_trace(
    input string case_name,
    input string event_name,
    input logic expected_valid,
    input logic expected_match
  );
    begin
      $display(
        "AI_EDA_TRACE|cycle=%0d|case=%s|event=%s|in_valid=%b|in_ready=%b|in_bit=%b|out_valid=%b|out_ready=%b|match=%b|expected_valid=%b|expected_match=%b",
        cycle_count, case_name, event_name, in_valid, in_ready, in_bit,
        out_valid, out_ready, match, expected_valid, expected_match
      );
    end
  endtask

  task automatic reset_dut;
    begin
      in_valid = 0;
      out_ready = 1;
      rst_n = 0;
      repeat (2) @(posedge clk);
      #1;
      expect_no_output("reset_clears_output");
      emit_trace("reset", "reset_applied", 1'b0, 1'b0);
      @(negedge clk);
      rst_n = 1;
    end
  endtask

  task automatic send_1011_until_match;
    begin
      // 连续发送 1,0,1,1；最后一个输出应为 match=1。
      @(negedge clk); expect_ready("match_ready_0"); in_valid=1; in_bit=1;
      @(posedge clk); #1; expect_no_output("match_latency_0"); emit_trace("match", "input_0", 1'b0, 1'b0);
      @(negedge clk); expect_ready("match_ready_1"); in_bit=0;
      @(posedge clk); #1; expect_output(1'b0, "match_output_0"); emit_trace("match", "input_1", 1'b1, 1'b0);
      @(negedge clk); expect_ready("match_ready_2"); in_bit=1;
      @(posedge clk); #1; expect_output(1'b0, "match_output_1"); emit_trace("match", "input_2", 1'b1, 1'b0);
      @(negedge clk); expect_ready("match_ready_3"); in_bit=1;
      @(posedge clk); #1; expect_output(1'b0, "match_output_2"); emit_trace("match", "input_3", 1'b1, 1'b0);
      @(negedge clk); in_valid=0;
      @(posedge clk); #1; expect_output(1'b1, "match_output_3"); emit_trace("match", "drain_match", 1'b1, 1'b1);
    end
  endtask

  initial begin
    bits[0]=1; bits[1]=0; bits[2]=1; bits[3]=1; bits[4]=0; bits[5]=1; bits[6]=1;
    expected[0]=0; expected[1]=0; expected[2]=0; expected[3]=1;
    expected[4]=0; expected[5]=0; expected[6]=1;
    in_valid=0; in_bit=0; out_ready=1;

    reset_dut();

    // 每周期接收 1011011，检查一拍延迟、连续吞吐、重叠匹配与顺序。
    for (index = 0; index < 7; index = index + 1) begin
      @(negedge clk);
      expect_ready($sformatf("overlap_ready_%0d", index));
      in_valid = 1;
      in_bit = bits[index];
      @(posedge clk); #1;
      if (index == 0)
        expect_no_output("one_cycle_latency_no_early_output");
      else
        expect_output(expected[index - 1], $sformatf("overlap_output_%0d", index - 1));
      emit_trace(
        "overlap", $sformatf("input_%0d", index),
        index == 0 ? 1'b0 : 1'b1,
        index == 0 ? 1'b0 : expected[index - 1]
      );
    end
    @(negedge clk);
    in_valid = 0;
    @(posedge clk); #1;
    expect_output(expected[6], "overlap_output_6");
    emit_trace("overlap", "drain_6", 1'b1, expected[6]);
    @(posedge clk); #1;
    expect_no_output("no_duplicate_after_overlap_stream");
    emit_trace("overlap", "drain_complete", 1'b0, 1'b0);

    // 反压：已有效的匹配结果必须稳定，解除反压后只能传输一次。
    reset_dut();
    send_1011_until_match();
    @(negedge clk);
    out_ready = 0;
    held_match = match;
    repeat (2) begin
      @(posedge clk); #1;
      if (out_valid !== 1'b1 || match !== held_match)
        fail("backpressure_hold", "out_valid or match changed while out_ready=0");
      emit_trace("backpressure", "hold", 1'b1, held_match);
    end
    @(negedge clk);
    out_ready = 1;
    @(posedge clk); #1;
    expect_no_output("backpressure_release_consumes_once");
    emit_trace("backpressure", "release", 1'b0, 1'b0);
    @(posedge clk); #1;
    expect_no_output("backpressure_release_no_duplicate");
    emit_trace("backpressure", "release_complete", 1'b0, 1'b0);

    // 同步复位：边沿之外不改变停住的输出；下一个上升沿才清空。
    reset_dut();
    send_1011_until_match();
    @(negedge clk);
    out_ready = 0;
    held_match = match;
    #2;
    rst_n = 0;
    #1;
    if (out_valid !== 1'b1 || match !== held_match)
      fail("synchronous_reset_midcycle", "output changed before reset clock edge");
    emit_trace("sync_reset", "midcycle", 1'b1, held_match);
    @(posedge clk); #1;
    expect_no_output("synchronous_reset_at_clock_edge");
    emit_trace("sync_reset", "clock_edge", 1'b0, 1'b0);
    @(negedge clk);
    rst_n = 1;
    out_ready = 1;
    @(posedge clk); #1;
    expect_no_output("reset_flushes_history_and_output");
    emit_trace("sync_reset", "released", 1'b0, 1'b0);

    if (failures == 0) $display("LAB_RESULT: PASS");
    else begin
      $display("LAB_RESULT: FAIL (%0d checks)", failures);
      $fatal(1);
    end
    $finish;
  end
endmodule
