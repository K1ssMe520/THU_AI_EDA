`timescale 1ns/1ps

// 仅用于功耗活动采样，不承担功能验收。
module tb_power_homework_aes128;
  logic clk = 0;
  logic rst_n = 0;
  logic start = 0;
  logic [127:0] key = 128'h0;
  logic [127:0] plaintext = 128'h0;
  logic ready;
  logic done;
  logic [127:0] ciphertext;
  string vcd_path;
  integer index;

  aes128 dut (.*);
  always #5 clk = ~clk;

  task automatic encrypt(input [127:0] task_key, input [127:0] task_plaintext);
    integer timeout;
    begin
      timeout = 0;
      while (ready !== 1'b1 && timeout < 200) begin
        @(posedge clk);
        #1;
        timeout = timeout + 1;
      end
      @(negedge clk);
      key = task_key;
      plaintext = task_plaintext;
      start = 1'b1;
      @(posedge clk);
      #1;
      start = 1'b0;
      timeout = 0;
      while (done !== 1'b1 && timeout < 200) begin
        @(posedge clk);
        #1;
        timeout = timeout + 1;
      end
      @(posedge clk);
      #1;
    end
  endtask

  initial begin
    if (!$value$plusargs("vcd=%s", vcd_path)) vcd_path = "activity.vcd";
    $dumpfile(vcd_path);
    $dumpvars(0, dut);
    repeat (3) @(posedge clk);
    @(negedge clk);
    rst_n = 1'b1;
    for (index = 0; index < 12; index = index + 1) begin
      // 连续加密不同 key/plaintext，制造状态、密钥扩展和轮函数的切换活动。
      encrypt(
        128'h000102030405060708090a0b0c0d0e0f + index,
        128'h00112233445566778899aabbccddeeff + index
      );
    end
    repeat (4) @(posedge clk);
    $finish;
  end
endmodule
