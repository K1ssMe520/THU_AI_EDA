## Design Topmodule

We are designing a complex digital circuit module. The following is the RTL module that can be used directly with the specific problem description.

### Problem Description

ModelName: [ModelName]

InputNode: [InputNode]

OutputNode: [OutputNode]

Specification: [Specification]

TestBench: [TestSpec]

### Retrieval Submodules



### Tips

Here is some tips that you need to follow:
1. The module name for RTL is [ModelName], the module name for TestBench is tb_[ModelName].
2. You can call these retrieval submodules without add their RTL to the response.
3. Please generate a module code to meet the requirements in the Specification, and TestBench to meet the requirements in TestBench.
4. Please use verilog for RTL and systemverilog for TestBench.
5. Fill in the generated RTL into ### RTL, and fill in the generated TestBench into ### TestBench.
6. We use the -g2005sv specification supported by iverilog for compilation. Please make sure that the verilog used can be supported.
7. Unpacked structs not supported in iverilog, do not use typedef struct.
8. When using the $bitstoreal function, please make sure that the parameter is 64bit.
9. You don't need to save waveform through \$dumpfile and \$dumvars.
10. In Testbench, please verify whether the function is correct. If you pass all the tests, please output TestSuccessed, otherwise you will output TestFailed.


Your Response Here:
### RTL
```verilog
```

### TestBench
```systemverilog
```
