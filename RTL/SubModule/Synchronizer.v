module Synchronizer #(
    parameter WIDTH = 1,
    parameter STAGES = 2
) (
    input wire clk,
    input wire rst_n,
    input wire [WIDTH-1:0] async_in,
    output wire [WIDTH-1:0] sync_out
);
    // Synchronizer chain
    reg [WIDTH-1:0] sync_chain [0:STAGES-1];
    
    genvar i;
    generate
        for (i = 0; i < STAGES; i = i + 1) begin : sync_stage
            always @(posedge clk or negedge rst_n) begin
                if (!rst_n) begin
                    sync_chain[i] <= {WIDTH{1'b0}};
                end else begin
                    if (i == 0) begin
                        sync_chain[i] <= async_in;
                    end else begin
                        sync_chain[i] <= sync_chain[i-1];
                    end
                end
            end
        end
    endgenerate
    
    assign sync_out = sync_chain[STAGES-1];
endmodule