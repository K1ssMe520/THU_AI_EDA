`timescale 1ns/1ps

module tb_agent_stream_filter;
  logic       clk = 0;
  logic       rst_n = 0;
  logic       in_valid = 0;
  logic [7:0] in_data = 0;
  logic       out_ready = 0;
  logic       in_ready;
  logic       out_valid;
  logic [7:0] out_data;
  logic [15:0] checksum;
  logic [3:0]  count;

  integer failures = 0;
  integer cycle = 0;
  integer exp_count = 0;
  integer exp_rd = 0;
  logic [15:0] exp_sum = 0;
  logic [7:0] exp_mem [0:511];
  integer i;

  stream_filter dut (.*);

  // 结构检查：这些实例要求 sync_fifo / checksum_acc 存在且接口匹配。
  logic       chk_fifo_full, chk_fifo_empty;
  logic [7:0] chk_fifo_dout;
  logic [3:0] chk_fifo_count;
  logic [15:0] chk_acc_sum;
  sync_fifo #(.DEPTH(8), .WIDTH(8)) u_fifo_check (
      .clk(clk), .rst_n(rst_n), .wr_en(1'b0), .rd_en(1'b0), .din(8'h00),
      .dout(chk_fifo_dout), .full(chk_fifo_full), .empty(chk_fifo_empty), .count(chk_fifo_count)
  );
  checksum_acc u_acc_check (
      .clk(clk), .rst_n(rst_n), .valid(1'b0), .data(8'h00), .checksum(chk_acc_sum)
  );

  always #5 clk = ~clk;

  function automatic integer expected_count;
    expected_count = exp_count - exp_rd;
  endfunction

  task automatic trace(input string name);
    begin
      $display(
          "AI_EDA_TRACE|cycle=%0d|event=%s|count=%0d|checksum=%04h|in_ready=%b|out_valid=%b|out_data=%02h|expected_count=%0d|expected_checksum=%04h|expected_in_ready=%b|expected_out_valid=%b|expected_out_data=%02h",
          cycle, name, count, checksum, in_ready, out_valid, out_data,
          expected_count(), exp_sum, (expected_count() < 8), (expected_count() > 0),
          expected_count() > 0 ? exp_mem[exp_rd] : 8'h00
      );
    end
  endtask

  task automatic check(input string name, input logic condition);
    begin
      if (!condition) begin
        failures = failures + 1;
        $display("CHECK: %s failed (cycle %0d)", name, cycle);
      end
    end
  endtask

  task automatic clock_edge(input string name);
    begin
      @(posedge clk); #1;
      cycle = cycle + 1;
      trace(name);
      check("count_trace", count === expected_count());
      check("checksum_trace", checksum === exp_sum);
      check("in_ready_trace", in_ready === (expected_count() < 8));
      check("out_valid_trace", out_valid === (expected_count() > 0));
      if (expected_count() > 0) check("out_data_trace", out_data === exp_mem[exp_rd]);
    end
  endtask

  task automatic write_byte(input [7:0] value, input string name);
    begin
      @(negedge clk);
      in_valid = 1;
      in_data = value;
      @(posedge clk); #1;
      cycle = cycle + 1;
      exp_sum = exp_sum + {8'd0, value};
      exp_mem[exp_count] = value;
      exp_count = exp_count + 1;
      trace(name);
      check("write_count", count === expected_count());
      check("write_checksum", checksum === exp_sum);
      check("write_in_ready", in_ready === (expected_count() < 8));
      @(negedge clk);
      in_valid = 0;
      in_data = 0;
    end
  endtask

  initial begin
    // Reset
    rst_n = 0; in_valid = 0; out_ready = 0; in_data = 0;
    repeat (2) @(posedge clk);
    #1; cycle = cycle + 1; trace("reset");
    check("reset_count", count === 0);
    check("reset_checksum", checksum === 0);
    check("reset_out_valid", out_valid === 0);
    check("reset_in_ready", in_ready === 1);
    @(negedge clk); rst_n = 1;

    // 1) Fill 8 bytes while not reading -> full / in_ready low.
    for (i = 0; i < 8; i = i + 1) write_byte(8'h10 + i[7:0], "fill");
    @(negedge clk); in_valid = 1; in_data = 8'hEE;
    @(posedge clk); #1; cycle = cycle + 1; trace("full_reject");
    check("full_reject_count", count === 8);
    check("full_reject_checksum", checksum === exp_sum);
    check("full_reject_ready", in_ready === 0);
    @(negedge clk); in_valid = 0; in_data = 0;

    // 2) Backpressure: out_valid/out_data must stay stable.
    @(negedge clk); out_ready = 0;
    repeat (2) begin
      @(posedge clk); #1; cycle = cycle + 1; trace("backpressure_hold");
      check("hold_valid", out_valid === 1);
      check("hold_data", out_data === exp_mem[exp_rd]);
    end

    // 3) Drain in order.
    for (i = 0; i < 8; i = i + 1) begin
      @(negedge clk); out_ready = 1;
      #1;
      trace("read_head");
      check("read_head_valid", out_valid === 1);
      check("read_head_data", out_data === exp_mem[exp_rd]);
      @(posedge clk); #1; cycle = cycle + 1;
      exp_rd = exp_rd + 1;
      trace("read_consume");
      check("read_count", count === expected_count());
      check("read_checksum", checksum === exp_sum);
      if (expected_count() > 0)
        check("read_next_data", out_valid === 1 && out_data === exp_mem[exp_rd]);
      else
        check("read_empty", out_valid === 0);
    end
    @(negedge clk); out_ready = 0;

    // 4) Simultaneous read/write (FIFO starts with 4 entries).
    for (i = 0; i < 4; i = i + 1) write_byte(8'h40 + i[7:0], "preload_rw");
    for (i = 0; i < 4; i = i + 1) begin
      @(negedge clk); in_valid = 1; in_data = 8'h80 + i[7:0]; out_ready = 1;
      #1;
      trace("rw_pre");
      check("rw_head_data", out_data === exp_mem[exp_rd]);
      @(posedge clk); #1; cycle = cycle + 1;
      exp_sum = exp_sum + {8'd0, (8'h80 + i[7:0])};
      exp_mem[exp_count] = 8'h80 + i[7:0];
      exp_count = exp_count + 1;
      exp_rd = exp_rd + 1;
      trace("rw_consume");
      check("rw_count", count === expected_count());
      check("rw_checksum", checksum === exp_sum);
      @(negedge clk); in_valid = 0; in_data = 0; out_ready = 0;
    end
    @(negedge clk); out_ready = 1;
    for (i = 0; i < 4; i = i + 1) begin
      @(posedge clk); #1; cycle = cycle + 1;
      exp_rd = exp_rd + 1;
      trace("drain_rw");
      check("drain_rw_count", count === expected_count());
    end
    @(negedge clk); out_ready = 0;

    // 5) Long stream for checksum wrap: write 8, then alternate read/write.
    for (i = 0; i < 8; i = i + 1) write_byte(8'hFF, "wrap_fill");
    for (i = 0; i < 300; i = i + 1) begin
      @(negedge clk); out_ready = 1;
      #1; trace("wrap_read");
      check("wrap_read_data", out_data === exp_mem[exp_rd]);
      @(posedge clk); #1; cycle = cycle + 1;
      exp_rd = exp_rd + 1;
      @(negedge clk); out_ready = 0; in_valid = 1; in_data = 8'hFF;
      #1; trace("wrap_write_pre");
      @(posedge clk); #1; cycle = cycle + 1;
      exp_sum = exp_sum + 16'd255;
      exp_mem[exp_count] = 8'hFF;
      exp_count = exp_count + 1;
      @(negedge clk); in_valid = 0; in_data = 0;
    end
    for (i = 0; i < 8; i = i + 1) begin
      @(negedge clk); out_ready = 1;
      #1; check("wrap_drain_data", out_data === exp_mem[exp_rd]);
      @(posedge clk); #1; cycle = cycle + 1; exp_rd = exp_rd + 1;
    end
    @(negedge clk); out_ready = 0;

    // 6) Mid-stream synchronous reset.
    for (i = 0; i < 4; i = i + 1) write_byte(8'hA0 + i[7:0], "before_reset");
    @(negedge clk); rst_n = 0;
    exp_count = 0; exp_rd = 0; exp_sum = 0;
    @(posedge clk); #1; cycle = cycle + 1; trace("synchronous_reset");
    check("reset_count_mid", count === 0);
    check("reset_checksum_mid", checksum === 0);
    check("reset_out_valid_mid", out_valid === 0);
    check("reset_in_ready_mid", in_ready === 1);
    @(negedge clk); rst_n = 1;
    write_byte(8'h5A, "after_reset_write");
    @(negedge clk); out_ready = 1;
    #1; check("after_reset_read_data", out_data === 8'h5A);
    @(posedge clk); #1; cycle = cycle + 1; exp_rd = exp_rd + 1;
    check("after_reset_checksum", checksum === 16'h005A);
    check("after_reset_count", count === 0);

    if (failures == 0) $display("LAB_RESULT: PASS");
    else begin
      $display("LAB_RESULT: FAIL (%0d checks)", failures);
      $fatal(1);
    end
    $finish;
  end
endmodule
