module Multiplexer #(
    parameter DATA_WIDTH = 8,
    parameter NUM_INPUTS = 4
) (
    input wire [NUM_INPUTS-1:0] sel,
    input wire [DATA_WIDTH-1:0] data_in [NUM_INPUTS-1:0],
    output reg [DATA_WIDTH-1:0] data_out
);
    always @(*) begin
        data_out = {DATA_WIDTH{1'b0}};
        for (int i = 0; i < NUM_INPUTS; i++) begin
            if (sel[i]) begin
                data_out = data_in[i];
            end
        end
    end
endmodule
