`timescale 1ns/1ps

module tb_homework_sync_fifo;
  logic clk = 0;
  logic rst_n = 0;
  logic wr_valid, wr_ready;
  logic [7:0] wr_data;
  logic rd_valid, rd_ready;
  logic [7:0] rd_data;
  logic [7:0] model [0:15];
  integer head = 0, tail = 0, count = 0, failures = 0;
  logic [7:0] held_data;

  sync_fifo dut (.*);
  always #5 clk = ~clk;

  task automatic fail(input string name, input string detail);
    begin failures = failures + 1; $display("CHECK: %s — %s", name, detail); end
  endtask

  task automatic check_outputs(input string name);
    begin
      if (wr_ready !== (count < 4)) fail(name, $sformatf("wr_ready expected %0d got %0b", count < 4, wr_ready));
      if (rd_valid !== (count > 0)) fail(name, $sformatf("rd_valid expected %0d got %0b", count > 0, rd_valid));
      if (count > 0 && rd_data !== model[head]) fail(name, $sformatf("rd_data expected %0h got %0h", model[head], rd_data));
    end
  endtask

  task automatic cycle(input logic wv, input logic [7:0] wd, input logic rr, input string name);
    logic write_fire, read_fire;
    begin
      @(negedge clk);
      check_outputs({name, "_before"});
      write_fire = wv && (count < 4);
      read_fire = rr && (count > 0);
      wr_valid = wv; wr_data = wd; rd_ready = rr;
      @(posedge clk);
      if (write_fire) begin
        model[tail] = wd;
        if (tail == 3) tail = 0; else tail = tail + 1;
      end
      if (read_fire) begin
        if (head == 3) head = 0; else head = head + 1;
      end
      if (write_fire && !read_fire) count = count + 1;
      if (read_fire && !write_fire) count = count - 1;
      @(negedge clk);
      check_outputs({name, "_after"});
      // Do not accidentally repeat this transaction while the next task waits.
      wr_valid = 0;
      rd_ready = 0;
    end
  endtask

  initial begin
    wr_valid=0; wr_data=0; rd_ready=0;
    repeat (2) @(negedge clk);
    rst_n=1;
    @(negedge clk); check_outputs("reset_release");

    cycle(1, 8'h11, 0, "write_11");
    cycle(1, 8'h22, 0, "write_22");
    held_data = rd_data;
    repeat (2) begin
      cycle(0, 8'h00, 0, "stall_read");
      if (rd_data !== held_data) fail("stall_read", "rd_data changed while rd_ready=0");
    end
    cycle(1, 8'h33, 1, "simultaneous_middle");
    cycle(1, 8'h44, 0, "write_44");
    cycle(1, 8'h55, 0, "write_full");
    cycle(1, 8'h66, 0, "blocked_write_full");
    cycle(0, 8'h00, 1, "read_1");
    cycle(0, 8'h00, 1, "read_2");
    cycle(0, 8'h00, 1, "read_3");
    cycle(0, 8'h00, 1, "read_4");
    cycle(0, 8'h00, 1, "read_empty");

    if (failures == 0) $display("LAB_RESULT: PASS");
    else begin $display("LAB_RESULT: FAIL (%0d checks)", failures); $fatal(1); end
    $finish;
  end
endmodule
