module Encoder #(
    parameter INPUT_WIDTH = 8,
    parameter OUTPUT_WIDTH = $clog2(INPUT_WIDTH)
) (
    input wire [INPUT_WIDTH-1:0] one_hot_in,
    output reg [OUTPUT_WIDTH-1:0] code_out,
    output reg valid
);
    always @(*) begin
        code_out = {OUTPUT_WIDTH{1'b0}};
        valid = 1'b0;
        
        for (int i = 0; i < INPUT_WIDTH; i++) begin
            if (one_hot_in[i]) begin
                code_out = i[OUTPUT_WIDTH-1:0];
                valid = 1'b1;
            end
        end
    end
endmodule