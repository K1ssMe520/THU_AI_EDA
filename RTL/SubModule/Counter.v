module Counter #(
    parameter WIDTH = 8,
    parameter MAX_COUNT = (1 << WIDTH) - 1,
    parameter RESET_VALUE = {WIDTH{1'b0}}
) (
    input wire clk,
    input wire rst_n,
    input wire en,
    input wire load,
    input wire [WIDTH-1:0] load_value,
    output reg [WIDTH-1:0] count,
    output wire overflow
);
    assign overflow = (count == MAX_COUNT);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            count <= RESET_VALUE;
        end else if (load) begin
            count <= load_value;
        end else if (en) begin
            if (count == MAX_COUNT) begin
                count <= {WIDTH{1'b0}};
            end else begin
                count <= count + 1'b1;
            end
        end
    end
endmodule