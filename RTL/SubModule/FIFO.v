module FIFO #(
    parameter DATA_WIDTH = 8,
    parameter DEPTH = 16,
    parameter ADDR_WIDTH = $clog2(DEPTH)
) (
    input wire clk,
    input wire rst_n,
    
    // Write interface
    input wire wr_en,
    input wire [DATA_WIDTH-1:0] data_in,
    output wire full,
    
    // Read interface
    input wire rd_en,
    output wire [DATA_WIDTH-1:0] data_out,
    output wire empty,
    
    // Status
    output wire [ADDR_WIDTH:0] count
);
    // Memory array
    reg [DATA_WIDTH-1:0] memory [0:DEPTH-1];
    
    // Pointers
    reg [ADDR_WIDTH-1:0] wr_ptr;
    reg [ADDR_WIDTH-1:0] rd_ptr;
    
    // Counter
    reg [ADDR_WIDTH:0] fifo_count;
    
    // Flags
    assign full = (fifo_count == DEPTH);
    assign empty = (fifo_count == 0);
    assign count = fifo_count;
    
    // Data output
    assign data_out = memory[rd_ptr];
    
    // FIFO control
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr <= {ADDR_WIDTH{1'b0}};
            rd_ptr <= {ADDR_WIDTH{1'b0}};
            fifo_count <= {ADDR_WIDTH+1{1'b0}};
        end else begin
            // Write operation
            if (wr_en && !full) begin
                memory[wr_ptr] <= data_in;
                wr_ptr <= wr_ptr + 1'b1;
            end
            
            // Read operation
            if (rd_en && !empty) begin
                rd_ptr <= rd_ptr + 1'b1;
            end
            
            // Update count
            case ({wr_en && !full, rd_en && !empty})
                2'b00: fifo_count <= fifo_count;
                2'b01: fifo_count <= fifo_count - 1'b1;
                2'b10: fifo_count <= fifo_count + 1'b1;
                2'b11: fifo_count <= fifo_count;
            endcase
        end
    end
endmodule