Please help me generate a floating-point multiplier unit, including RTL code and TestBench. 
### Problem Description

ModelName: fp_multiplier

InputNode:
- clk: Clock signal (rising edge effective).
- rst_n: Active-low reset signal.
- A: 16-bit FP16 format input, operand one.
- B: 16-bit FP16 format input, operand two.
- Ready: Input data ready signal, high effective.

OutputNode:
- C: 16-bit FP16 format output.
- Valid: Device idle and result ready signal, high effective.

Specification:
- Support IEEE 754 Half-Precision Floating-Point Format (FP16):
    - Handle all special cases (zero, infinity, NaN) as specified by IEEE 754.
    - Ensure correct rounding to the nearest even value.
- Use valid and ready signals for handshake. When valid is high, the input operands A and B are ready. When ready is high, the result C is valid.
- TestBench should contain the following test conditions:
    - Basic Multiplication: Positive numbers (e.g., 2.0 * 3.0); Negative numbers (e.g., -2.0 * 3.0); Mixed signs (e.g., -2.0 * -3.0);
    - Zero Multiplication: Multiplication involving zero (e.g., 0.0 * 2.0);
    - Infinity Multiplication: Multiplication involving infinity (e.g., inf * 2.0);
    - NaN Multiplication: Multiplication involving NaN (e.g., NaN * 2.0);
    - Subnormal Numbers: Multiplication involving very small numbers (e.g., 5.96e-8 * 5.96e-8);
    - Overflow and Underflow: Test cases that result in overflow or underflow;
    - Edge Cases: Multiplication of maximum representable values (e.g., 65504.0 * 1.5); Multiplication of minimum representable values (e.g., 5.96e-8 * 5.96e-8);


### RTL
```verilog
module fp_multiplier
(
    input wire clk,
    input wire rst_n,
    input wire [15:0] A,
    input wire [15:0] B,
    output wire [15:0] C,
    input wire valid,
    output wire ready
)
```

### TestBench
```systemverilog
module fp_multiplier_tb;
```


### Tips
Here is some tips that you need to follow:
1. When responsing, please fill in RTL and TestBench respectively in the code box starting with "### RTL" and "### TestBench".
2. Use Verilog for RTL and SystemVerilog for TestBench.
3. We use the -g2005sv specification supported by iverilog for compilation. Please make sure that the verilog used can be supported.
4. Unpacked structs not supported in iverilog, do not use typedef struct.
5. When using the $bitstoreal function, please make sure that the parameter is 64bit.
6. Save the simulated waveform diagram with $dumpfile and $dumpvars instructions. Save the vcd file as Out/wave.vcd
7. In Testbench, please verify whether the function is correct. If you pass all the tests, please output TestSuccessed, otherwise you will output TestFailed.

