module Decoder #(
    parameter INPUT_WIDTH = 3,
    parameter OUTPUT_WIDTH = 2**INPUT_WIDTH
) (
    input wire [INPUT_WIDTH-1:0] code_in,
    output reg [OUTPUT_WIDTH-1:0] one_hot_out
);
    always @(*) begin
        one_hot_out = {OUTPUT_WIDTH{1'b0}};
        one_hot_out[code_in] = 1'b1;
    end
endmodule