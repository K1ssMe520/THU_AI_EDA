`timescale 1ns/1ps

// 教师测试平台：AES-128 单模块加密核。
// 检查复位/握手、标准向量、连续加密、忙时复位与 done 单脉冲。
module tb_homework_aes128;
  logic clk = 0;
  logic rst_n = 0;
  logic start = 0;
  logic [127:0] key = 128'h0;
  logic [127:0] plaintext = 128'h0;
  logic ready;
  logic done;
  logic [127:0] ciphertext;
  integer failures = 0;
  integer cycle_count = 0;
  integer cases = 0;

  aes128 dut (.*);
  always #5 clk = ~clk;
  always @(posedge clk) cycle_count <= cycle_count + 1;

  task automatic fail(input string name, input string detail);
    begin
      failures = failures + 1;
      $display("CHECK: %s — %s", name, detail);
    end
  endtask

  task automatic emit_trace(
    input string test_name,
    input string event_name,
    input logic ok,
    input string detail
  );
    begin
      $display(
        "AI_EDA_TRACE|cycle=%0d|test=%s|event=%s|ok=%0d|detail=%s",
        cycle_count, test_name, event_name, ok, detail
      );
    end
  endtask

  task automatic wait_ready(input string name);
    integer timeout;
    begin
      timeout = 0;
      while (ready !== 1'b1 && timeout < 200) begin
        @(posedge clk);
        #1;
        timeout = timeout + 1;
      end
      if (ready !== 1'b1) begin
        fail(name, "ready 在 200 个周期内没有恢复为 1");
        emit_trace(name, "ready_timeout", 1'b0, "ready_stuck_low");
      end
    end
  endtask

  task automatic run_vector(
    input [127:0] test_key,
    input [127:0] test_plaintext,
    input [127:0] expected,
    input string name
  );
    integer timeout;
    logic [127:0] captured;
    begin
      wait_ready(name);
      @(negedge clk);
      key = test_key;
      plaintext = test_plaintext;
      start = 1'b1;
      emit_trace(name, "start", 1'b1, "start_asserted");
      @(posedge clk);
      #1;
      start = 1'b0;
      if (done !== 1'b0) begin
        fail(name, "start 后第一个时钟沿就出现 done");
        emit_trace(name, "early_done", 1'b0, "done_too_early");
      end
      timeout = 0;
      while (done !== 1'b1 && timeout < 200) begin
        @(posedge clk);
        #1;
        timeout = timeout + 1;
      end
      if (done !== 1'b1) begin
        fail(name, "done 在 200 个周期内没有拉高");
        emit_trace(name, "timeout", 1'b0, "done_timeout");
      end else begin
        captured = ciphertext;
        if (timeout > 200) begin
          fail(name, "加密延迟超过 200 个周期");
        end
        if (captured !== expected) begin
          fail(name, $sformatf("ciphertext 不一致：得到 %032h，期望 %032h", captured, expected));
          emit_trace(name, "done", 1'b0, "ciphertext_mismatch");
        end else begin
          emit_trace(name, "done", 1'b1, "ciphertext_ok");
        end
        @(posedge clk);
        #1;
        if (done !== 1'b0) begin
          fail(name, "done 没有保持单周期脉冲");
          emit_trace(name, "done_pulse", 1'b0, "done_too_long");
        end else begin
          emit_trace(name, "done_pulse", 1'b1, "done_one_cycle");
        end
        if (ready !== 1'b1) begin
          fail(name, "done 之后 ready 没有恢复为 1");
          emit_trace(name, "ready_after_done", 1'b0, "ready_not_restored");
        end else begin
          emit_trace(name, "ready_after_done", 1'b1, "ready_restored");
        end
      end
      cases = cases + 1;
    end
  endtask

  task automatic test_reset_while_busy();
    integer timeout;
    begin
      wait_ready("mid_reset");
      @(negedge clk);
      key = 128'h2b7e151628aed2a6abf7158809cf4f3c;
      plaintext = 128'h3243f6a8885a308d313198a2e0370734;
      start = 1'b1;
      @(posedge clk);
      #1;
      start = 1'b0;
      repeat (3) @(posedge clk);
      @(negedge clk);
      rst_n = 1'b0;
      repeat (2) @(posedge clk);
      #1;
      if (done !== 1'b0) begin
        fail("mid_reset", "忙时复位后 done 仍为 1");
        emit_trace("mid_reset", "done_cleared", 1'b0, "done_still_high");
      end else begin
        emit_trace("mid_reset", "done_cleared", 1'b1, "done_cleared");
      end
      @(negedge clk);
      rst_n = 1'b1;
      timeout = 0;
      while (ready !== 1'b1 && timeout < 200) begin
        @(posedge clk);
        #1;
        timeout = timeout + 1;
      end
      if (ready !== 1'b1) begin
        fail("mid_reset", "复位释放后 ready 没有恢复为 1");
        emit_trace("mid_reset", "ready_restored", 1'b0, "ready_stuck_low");
      end else begin
        emit_trace("mid_reset", "ready_restored", 1'b1, "ready_ok");
      end
    end
  endtask

  initial begin
    rst_n = 1'b0;
    start = 1'b0;
    key = 128'h0;
    plaintext = 128'h0;

    repeat (4) @(posedge clk);
    #1;
    if (ready !== 1'b1) begin
      fail("reset", "复位期间 ready 应为 1");
      emit_trace("reset", "ready", 1'b0, "ready_not_high");
    end else begin
      emit_trace("reset", "ready", 1'b1, "ready_high");
    end
    if (done !== 1'b0) begin
      fail("reset", "复位期间 done 应为 0");
      emit_trace("reset", "done", 1'b0, "done_not_low");
    end else begin
      emit_trace("reset", "done", 1'b1, "done_low");
    end

    @(negedge clk);
    rst_n = 1'b1;
    @(posedge clk);
    #1;

    // 三组 FIPS-197 标准向量 + 再跑一组，检查连续任务不会复用旧 key。
    run_vector(
      128'h000102030405060708090a0b0c0d0e0f,
      128'h00112233445566778899aabbccddeeff,
      128'h69c4e0d86a7b0430d8cdb78070b4c55a,
      "fips_c1"
    );
    run_vector(
      128'h00000000000000000000000000000000,
      128'h00000000000000000000000000000000,
      128'h66e94bd4ef8a2c3b884cfa59ca342b2e,
      "fips_c2"
    );
    run_vector(
      128'h2b7e151628aed2a6abf7158809cf4f3c,
      128'h3243f6a8885a308d313198a2e0370734,
      128'h3925841d02dc09fbdc118597196a0b32,
      "fips_b"
    );
    run_vector(
      128'h000102030405060708090a0b0c0d0e0f,
      128'h00112233445566778899aabbccddeeff,
      128'h69c4e0d86a7b0430d8cdb78070b4c55a,
      "fips_c1_repeat"
    );

    test_reset_while_busy();

    // 忙时复位后再跑一组向量，确认状态已完全清空。
    run_vector(
      128'h000102030405060708090a0b0c0d0e0f,
      128'h00112233445566778899aabbccddeeff,
      128'h69c4e0d86a7b0430d8cdb78070b4c55a,
      "after_mid_reset"
    );

    if (failures == 0) begin
      $display("LAB_RESULT: PASS (%0d vectors)", cases);
    end else begin
      $display("LAB_RESULT: FAIL (%0d checks)", failures);
      $fatal(1);
    end
    $finish;
  end
endmodule
