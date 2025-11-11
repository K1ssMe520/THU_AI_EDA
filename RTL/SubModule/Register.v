module Register #(
    parameter WIDTH = 8,
    parameter RESET_VALUE = {WIDTH{1'b0}}
) (
    input wire clk,
    input wire rst_n,
    input wire en,
    input wire [WIDTH-1:0] d,
    output reg [WIDTH-1:0] q
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            q <= RESET_VALUE;
        end else if (en) begin
            q <= d;
        end
    end
endmodule