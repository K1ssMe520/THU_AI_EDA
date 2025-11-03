Please help me generate a floating-point multiplier unit, including RTL code and TestBench. 

The start code of the module is as follows. 

When responsing, please fill in RTL and TestBench respectively in the code box starting with "### RTL" and "### TestBench" as shown below.

### RTL
```verilog
module fp_multiplier
(
    input wire clk,
    input wire rst_n,
    input wire [xx:0] A,
    input wire [xx:0] B,
    output wire [xx:0] C,
    ...
)
...
endmodule
```

### TestBench
```systemverilog
module fp_multiplier_tb;
...
endmodule
```


### Tips
Here is some tips that you need to follow:
1. Use Verilog for RTL and SystemVerilog for TestBench.
2. We use the -g2005sv specification supported by iverilog for compilation. Please make sure that the verilog used can be supported.
3. Unpacked structs not supported in iverilog, do not use typedef struct.
4. The use of string type is prohibited.
5. When using the $bitstoreal function, please make sure that the parameter is 64bit.
6. Save the simulated waveform diagram with $dumpfile and $dumpvars instructions. Save the vcd file as Out/wave.vcd
7. In Testbench, please verify whether the function is correct. If you pass all the tests, please output TestSuccessed, otherwise you will output TestFailed.