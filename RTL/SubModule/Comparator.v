module Comparator #(
    parameter WIDTH = 8
) (
    input wire [WIDTH-1:0] a,
    input wire [WIDTH-1:0] b,
    output reg gt,        // a > b
    output reg eq,        // a == b
    output reg lt         // a < b
);
    always @(*) begin
        gt = (a > b);
        eq = (a == b);
        lt = (a < b);
    end
endmodule