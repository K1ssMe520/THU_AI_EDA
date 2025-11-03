Below is a template for the problem input and response. You should reference this response format.

---

Here is an examplaray prompt input:
Please help me generate a FIFO, including RTL code and TestBench.
## Problem Description

ModelName: FIFO

InputNode:

- clk: Clock signal (rising edge effective).
- rst_n: Active-low reset signal.
- data_in: 32-bit input data.
- wr_en: Write enable signal, high effective.
- rd_en: Read enable signal, high effective.

OutputNode:

- data_out: 32-bit output data.
- full: FIFO full signal, high effective.
- empty: FIFO empty signal, high effective.

Specification:

- FIFO Size: 16 entries, each entry is 32 bits wide.
- Behavior:
  - When wr_en is high and full is low, the input data data_in is written into the FIFO.
  - When rd_en is high and empty is low, the oldest data in the FIFO is read out as data_out.
  - If wr_en is high and full is high, the write operation is ignored.
  - If rd_en is high and empty is high, the data_out remains unchanged.
- TestBench should contain the following test conditions:
  - Basic Write and Read Operations: Write a few data entries and read them back in sequence.
  - Concurrent Write and Read: Write and read data simultaneously to test FIFO behavior.
  - FIFO Full Condition: Write data continuously until the FIFO is full, then attempt to write more data.
  - FIFO Empty Condition: Read data continuously until the FIFO is empty, then attempt to read more data.
  - Mixed Write and Read Patterns: Write and read data in various patterns to test FIFO robustness.
  - Edge Cases: Write maximum number of entries and then read them back; read all entries and then write again.
  - Reset Behavior: Test FIFO behavior after a reset signal is asserted.


Here is an examplaray prompt output:

### RTL
```verilog
module FIFO (
    input wire clk,
    input wire rst_n,
    input wire [31:0] data_in,
    input wire wr_en,
    input wire rd_en,
    output reg [31:0] data_out,
    output wire full,
    output wire empty
);

    // FIFO parameters
    parameter DEPTH = 16;
    parameter WIDTH = 32;
    
    // Internal memory
    reg [WIDTH-1:0] memory [0:DEPTH-1];
    
    // Pointers
    reg [3:0] wr_ptr;
    reg [3:0] rd_ptr;
    reg [4:0] count;  // Need 5 bits to count 0-16
    
    // Full and empty flags
    assign full = (count == DEPTH);
    assign empty = (count == 0);
    
    // FIFO control logic
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            // Reset all pointers and memory
            wr_ptr <= 0;
            rd_ptr <= 0;
            count <= 0;
            data_out <= 0;
            
            // Optional: Clear memory on reset
            for (integer i = 0; i < DEPTH; i = i + 1) begin
                memory[i] <= 0;
            end
        end else begin
            // Write operation
            if (wr_en && !full) begin
                memory[wr_ptr] <= data_in;
                wr_ptr <= wr_ptr + 1;
                if (wr_ptr == DEPTH-1) wr_ptr <= 0;
            end
            
            // Read operation
            if (rd_en && !empty) begin
                data_out <= memory[rd_ptr];
                rd_ptr <= rd_ptr + 1;
                if (rd_ptr == DEPTH-1) rd_ptr <= 0;
            end
            
            // Update count
            case ({wr_en && !full, rd_en && !empty})
                2'b00: count <= count;  // No operation
                2'b01: count <= count - 1;  // Read only
                2'b10: count <= count + 1;  // Write only
                2'b11: count <= count;  // Simultaneous read and write
            endcase
        end
    end

endmodule
```

### TestBench
```systemverilog
module FIFO_tb;
    // Parameters
    parameter CLK_PERIOD = 10;
    parameter DEPTH = 16;
    
    // Signals
    reg clk;
    reg rst_n;
    reg [31:0] data_in;
    reg wr_en;
    reg rd_en;
    wire [31:0] data_out;
    wire full;
    wire empty;
    
    // Test variables
    reg [31:0] expected_data;
    integer error_count;
    integer test_case;
    
    // Instantiate DUT
    FIFO dut (
        .clk(clk),
        .rst_n(rst_n),
        .data_in(data_in),
        .wr_en(wr_en),
        .rd_en(rd_en),
        .data_out(data_out),
        .full(full),
        .empty(empty)
    );
    
    // Clock generation
    always #(CLK_PERIOD/2) clk = ~clk;
    
    // Waveform dumping
    initial begin
        $dumpfile("Out/wave.vcd");
        $dumpvars(0, FIFO_tb);
    end
    
    // Test tasks
    task write_data(input [31:0] data);
        begin
            data_in = data;
            wr_en = 1;
            @(posedge clk);
            wr_en = 0;
        end
    endtask
    
    task read_data(output [31:0] data);
        begin
            rd_en = 1;
            @(posedge clk);
            rd_en = 0;
            data = data_out;
        end
    endtask
    
    task reset_fifo;
        begin
            rst_n = 0;
            wr_en = 0;
            rd_en = 0;
            data_in = 0;
            @(posedge clk);
            @(posedge clk);
            rst_n = 1;
            @(posedge clk);
        end
    endtask
    
    task check_result(input [31:0] actual, input [31:0] expected, input string test_name);
        begin
            if (actual !== expected) begin
                $display("ERROR: %s - Expected: %h, Got: %h", test_name, expected, actual);
                error_count = error_count + 1;
            end
        end
    endtask
    
    // Main test sequence
    initial begin
        // Initialize
        clk = 0;
        error_count = 0;
        test_case = 0;
        
        // Test 1: Reset behavior
        test_case = 1;
        $display("Test %0d: Reset Behavior", test_case);
        reset_fifo();
        check_result(data_out, 32'h0, "Reset data_out");
        check_result(empty, 1'b1, "Reset empty flag");
        check_result(full, 1'b0, "Reset full flag");
        
        // Test 2: Basic write and read operations
        test_case = 2;
        $display("Test %0d: Basic Write and Read Operations", test_case);
        reset_fifo();
        
        // Write 4 data items
        write_data(32'h12345678);
        write_data(32'hABCDEF01);
        write_data(32'hDEADBEEF);
        write_data(32'hCAFEBABE);
        
        // Read them back
        read_data(expected_data);
        check_result(expected_data, 32'h12345678, "First read");
        read_data(expected_data);
        check_result(expected_data, 32'hABCDEF01, "Second read");
        read_data(expected_data);
        check_result(expected_data, 32'hDEADBEEF, "Third read");
        read_data(expected_data);
        check_result(expected_data, 32'hCAFEBABE, "Fourth read");
        
        // Test 3: Concurrent write and read
        test_case = 3;
        $display("Test %0d: Concurrent Write and Read", test_case);
        reset_fifo();
        
        fork
            begin
                for (integer i = 0; i < 8; i = i + 1) begin
                    write_data(32'h1000 + i);
                end
            end
            begin
                for (integer i = 0; i < 8; i = i + 1) begin
                    read_data(expected_data);
                    check_result(expected_data, 32'h1000 + i, $sformatf("Concurrent read %0d", i));
                end
            end
        join
        
        // Test 4: FIFO full condition
        test_case = 4;
        $display("Test %0d: FIFO Full Condition", test_case);
        reset_fifo();
        
        // Fill the FIFO
        for (integer i = 0; i < DEPTH; i = i + 1) begin
            write_data(32'h2000 + i);
            if (i == DEPTH-1) begin
                check_result(full, 1'b1, "FIFO should be full");
            end
        end
        
        // Try to write when full (should be ignored)
        data_in = 32'hBAD0BAD0;
        wr_en = 1;
        @(posedge clk);
        wr_en = 0;
        @(posedge clk);
        check_result(full, 1'b1, "FIFO should remain full");
        
        // Test 5: FIFO empty condition
        test_case = 5;
        $display("Test %0d: FIFO Empty Condition", test_case);
        
        // Empty the FIFO
        for (integer i = 0; i < DEPTH; i = i + 1) begin
            read_data(expected_data);
            check_result(expected_data, 32'h2000 + i, $sformatf("Emptying read %0d", i));
            if (i == DEPTH-1) begin
                check_result(empty, 1'b1, "FIFO should be empty");
            end
        end
        
        // Try to read when empty
        rd_en = 1;
        @(posedge clk);
        rd_en = 0;
        @(posedge clk);
        check_result(empty, 1'b1, "FIFO should remain empty");
        
        // Test 6: Mixed write and read patterns
        test_case = 6;
        $display("Test %0d: Mixed Write and Read Patterns", test_case);
        reset_fifo();
        
        // Pattern 1: Write 3, read 2, write 2, read 3
        write_data(32'h3001); write_data(32'h3002); write_data(32'h3003);
        read_data(expected_data); check_result(expected_data, 32'h3001, "Mixed pattern 1a");
        read_data(expected_data); check_result(expected_data, 32'h3002, "Mixed pattern 1b");
        write_data(32'h3004); write_data(32'h3005);
        read_data(expected_data); check_result(expected_data, 32'h3003, "Mixed pattern 1c");
        read_data(expected_data); check_result(expected_data, 32'h3004, "Mixed pattern 1d");
        read_data(expected_data); check_result(expected_data, 32'h3005, "Mixed pattern 1e");
        
        // Test 7: Edge cases
        test_case = 7;
        $display("Test %0d: Edge Cases", test_case);
        reset_fifo();
        
        // Write maximum entries and read them back
        for (integer i = 0; i < DEPTH; i = i + 1) begin
            write_data(32'h4000 + i);
        end
        check_result(full, 1'b1, "Edge case - full");
        
        for (integer i = 0; i < DEPTH; i = i + 1) begin
            read_data(expected_data);
            check_result(expected_data, 32'h4000 + i, $sformatf("Edge case read %0d", i));
        end
        check_result(empty, 1'b1, "Edge case - empty");
        
        // Write again after reading all
        write_data(32'h5001);
        read_data(expected_data);
        check_result(expected_data, 32'h5001, "Write after complete read");
        
        // Final result
        if (error_count == 0) begin
            $display("TestSuccessed: All tests passed!");
        end else begin
            $display("TestFailed: %0d errors found", error_count);
        end
        
        $finish;
    end

endmodule
```

---

Here is the real input prompt

Please help me generate [ModelName], including RTL code and TestBench.

## Problem Description
ModelName: [ModelName]

InputNode: [InputNode]

OutputNode: [OutputNode]

Specification: [Specification]


### Tips
Here is some tips that you need to follow:
1. Use Verilog for RTL and SystemVerilog for TestBench.
2. We use the -g2005sv specification supported by iverilog for compilation. Please make sure that the verilog used can be supported.
3. Unpacked structs not supported in iverilog, do not use typedef struct.
4. When using the $bitstoreal function, please make sure that the parameter is 64bit.
5. Save the simulated waveform diagram with $dumpfile and $dumpvars instructions. Save the vcd file as Out/wave.vcd
6. In Testbench, please verify whether the function is correct. If you pass all the tests, please output TestSuccessed, otherwise you will output TestFailed.