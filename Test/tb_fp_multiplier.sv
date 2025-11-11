module tb_fp_multiplier;

reg clk;
reg rst_n;
reg Ready;
reg [15:0] A;
reg [15:0] B;
wire [15:0] C;
wire Valid;

fp_multiplier dut (
    .clk(clk),
    .rst_n(rst_n),
    .A(A),
    .B(B),
    .Ready(Ready),
    .C(C),
    .Valid(Valid)
);

initial begin
    clk = 0;
    forever #5 clk = ~clk;
end

initial begin
    rst_n = 0;
    #10;
    rst_n = 1;
end

initial begin
    Ready = 0;
    A = 0;
    B = 0;
    @(posedge rst_n);
    #10;

    test_case(16'h4000, 16'h4200, 16'h4600, "2.0 * 3.0 = 6.0");
    test_case(16'hC000, 16'h4200, 16'hC600, "-2.0 * 3.0 = -6.0");
    test_case(16'hC000, 16'hC200, 16'h4600, "-2.0 * -3.0 = 6.0");
    test_case(16'h0000, 16'h4200, 16'h0000, "0.0 * 3.0 = 0.0");
    test_case(16'h7C00, 16'h4200, 16'h7C00, "inf * 3.0 = inf");
    test_case(16'h7E00, 16'h4200, 16'h7E00, "NaN * 3.0 = NaN");
    test_case(16'h0001, 16'h0001, 16'h0000, "5.96e-8 * 5.96e-8 = 0.0");
    test_case(16'h7BFF, 16'h3E00, 16'h7C00, "65504.0 * 1.5 = inf");
    test_case(16'h7BFF, 16'h7BFF, 16'h7C00, "65504.0 * 65504.0 = inf");
    test_case(16'h0001, 16'h0001, 16'h0000, "min * min = 0");

    $display("TestSuccessed");
    $finish;
end

task test_case(input [15:0] a, input [15:0] b, input [15:0] expected_c, string name);
    begin
        A = a;
        B = b;
        Ready = 1;
        @(posedge clk);
        Ready = 0;
        // Wait for result (4 clock cycles for pipelined design)
        repeat(4) @(posedge clk);
        if (Valid !== 1'b1) begin
            $display("Error: Valid not high for test %s", name);
            $finish;
        end
        if (C !== expected_c) begin
            $display("Error: for test %s, expected %h, got %h", name, expected_c, C);
            $finish;
        end
        $display("Pass: %s", name);
    end
endtask

endmodule