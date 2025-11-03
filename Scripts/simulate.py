import subprocess
import sys
import argparse
import os

def simulate():
    '''
    使用方法: python Scripts/simulate.py top_model_tb model_tb.sv model1.v model2.v
    需要三个参数，首先是testbench中仿真的顶层模块名，其次是testbench的文件名，最后是一系列的RTL代码文件名称
    '''
    os.system("rm -rf Out/*")
    
    parser = argparse.ArgumentParser(description="处理模块名、测试平台名和RTL文件名")
    parser.add_argument("module_name", type=str, help="模块名")
    parser.add_argument("testbench_name", type=str, help="测试平台名")
    parser.add_argument("rtl_files", nargs="+", help="RTL文件名列表")

    args = parser.parse_args()

    iverilog_cmd = ['iverilog']
    iverilog_cmd += ['-g2005-sv']
    iverilog_cmd += ['-o', r'Out/out.vvp']
    iverilog_cmd += ['-D', r'OUTPUT="Out/signature.output"']
    iverilog_cmd += ['-s', args.module_name]

    iverilog_cmd.append('./Test/' + args.testbench_name)
    for RTL in args.rtl_files:
        iverilog_cmd.append('./RTL/' + RTL)

    # print(iverilog_cmd)

    # 执行编译
    result = subprocess.run(iverilog_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    combined_output = result.stdout + result.stderr
    print(combined_output)

    # 执行仿真
    vvp_cmd = [r'vvp', r'Out/out.vvp']
    result = subprocess.run(vvp_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    combined_output = result.stdout + result.stderr
    print(combined_output)


if __name__ == '__main__':
    simulate()
