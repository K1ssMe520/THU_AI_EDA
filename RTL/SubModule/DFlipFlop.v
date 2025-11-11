module DFlipFlop #(
    parameter RESET_VALUE = 1'b0
) (
    input wire clk,
    input wire rst_n,
    input wire d,
    output reg q
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            q <= RESET_VALUE;
        end else begin
            q <= d;
        end
    end
endmodule