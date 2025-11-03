import re
import sys
from pathlib import Path
root_dir = str(Path(__file__).parent.parent)
sys.path.append(root_dir)

from Basic.circuit import CIRCUIT
from Basic.tools import read_markdown, extract_code, write_file, replace_prompt
from Basic.LLM_interface import DeepSeek_R1

test_prompts = [
    "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets? Explain your reasoning step by step.",
    "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Show your work.",
    "Sarah is twice as old as John. In 5 years, the sum of their ages will be 35. How old are Sarah and John now? Provide a detailed solution.",
    "There are three boxes: one contains only apples, one contains only oranges, and one contains both apples and oranges. The labels on the boxes are all wrong. You can only pick one fruit from one box (without looking inside). How do you determine the correct labels for all three boxes? Explain your reasoning process."
]

prompt_paths = {
    'naive' : 'Prompts/naive_prompt.md',
    'zero_shot1' : 'Prompts/zero_shot_prompt1.md',
    'zero_shot2' : 'Prompts/zero_shot_prompt2.md',
    'zero_shot3' : 'Prompts/zero_shot_prompt3.md',
    'one_shot1' : 'Prompts/one_shot_prompt1.md',
    'one_shot2' : 'Prompts/one_shot_prompt2.md',
    'homework1' : 'Prompts/homework_prompt1.md'
}

if __name__ == '__main__':
    # No-Reason No-Stream interface ---------------------------
    # response = DeepSeek_R1.get_answer( 
    #     request = test_prompts[0],
    #     system_prompt = None,
    #     supplement = None,
    #     stream = False,
    #     is_reason = False,
    #     is_print = True
    # )
    
    
    # No-Reason Stream interface ---------------------------
    # response = DeepSeek_R1.get_answer( 
    #     request = test_prompts[0],
    #     system_prompt = None,
    #     supplement = None,
    #     stream = True,
    #     is_reason = False,
    #     is_print = True
    # )

    # Reason Stream interface -------------------------------
    # response = DeepSeek_R1.get_answer( 
    #     request = test_prompts[0],
    #     system_prompt = None,
    #     supplement = None,
    #     stream = True,
    #     is_reason = True,
    #     is_print = True
    # )

    # Naive Prompt ------------------------------------------
    # prompt = read_markdown(prompt_paths['naive'])
    # response = DeepSeek_R1.get_answer( 
    #     request = prompt,
    #     system_prompt = None,
    #     supplement = None,
    #     stream = True,
    #     is_reason = False,
    #     is_print = True
    # )


    # Zero Shot Prompt 1 ---------------------------------------
    # prompt = read_markdown(prompt_paths['zero_shot1'])
    # response = DeepSeek_R1.get_answer( 
    #     request = prompt,
    #     system_prompt = None,
    #     supplement = None,
    #     stream = True,
    #     is_reason = False,
    #     is_print = True
    # )

    # RTL = extract_code(response, "RTL", "verilog")
    # TestBench = extract_code(response, "TestBench", "systemverilog")
    
    # write_file(RTL, "RTL/zero_shot1_fp.v")
    # write_file(TestBench, "Test/test_zero_shot1_fp.sv")


    # Zero Shot Prompt 2 ---------------------------------------
    # prompt = read_markdown(prompt_paths['zero_shot2'])
    # response = DeepSeek_R1.get_answer( 
    #     request = prompt,
    #     system_prompt = None,
    #     supplement = None,
    #     stream = True,
    #     is_reason = False,
    #     is_print = True
    # )

    # RTL = extract_code(response, "RTL", "verilog")
    # TestBench = extract_code(response, "TestBench", "systemverilog")
    
    # write_file(RTL, "RTL/zero_shot2_fp.v")
    # write_file(TestBench, "Test/test_zero_shot2_fp.sv")


    # Zero Shot Prompt 3 ---------------------------------------
    # prompt = read_markdown(prompt_paths['zero_shot3'])
    # response = DeepSeek_R1.get_answer( 
    #     request = prompt,
    #     system_prompt = None,
    #     supplement = None,
    #     stream = True,
    #     is_reason = False,
    #     is_print = True
    # )

    # RTL = extract_code(response, "RTL", "verilog")
    # TestBench = extract_code(response, "TestBench", "systemverilog")
    
    # write_file(RTL, "RTL/zero_shot3_fp.v")
    # write_file(TestBench, "Test/test_zero_shot3_fp.sv")


    # One Shot Prompt 1 ---------------------------------------
    # prompt = read_markdown(prompt_paths['one_shot1'])
    # response = DeepSeek_R1.get_answer( 
    #     request = prompt,
    #     system_prompt = None,
    #     supplement = None,
    #     stream = True,
    #     is_reason = False,
    #     is_print = True
    # )

    # RTL = extract_code(response, "RTL", "verilog")
    # TestBench = extract_code(response, "TestBench", "systemverilog")
    
    # write_file(RTL, "RTL/one_shot1_fp.v")
    # write_file(TestBench, "Test/one_zero_shot1_fp.sv")


    # One Shot Prompt 2 ---------------------------------------
    # fp_multiplier = CIRCUIT.load_circuit("Json/fp_multiplier.json")
    # prompt = read_markdown(prompt_paths['one_shot2'])
    # prompt = replace_prompt(prompt, fp_multiplier.get_replacement())
    
    # print("\n\n\n Get Response:\n")
    
    # response = DeepSeek_R1.get_answer( 
    #     request = prompt,
    #     system_prompt = None,
    #     supplement = None,
    #     stream = True,
    #     is_reason = False,
    #     is_print = True
    # )

    # RTL = extract_code(response, "RTL", "verilog")
    # TestBench = extract_code(response, "TestBench", "systemverilog")
    
    # fp_multiplier.rtl_code = RTL
    # fp_multiplier.testbench_code = TestBench
    # fp_multiplier.save_all_componet()


    # Homework 1 -----------------------------------------------
    async_fifo = CIRCUIT(
        model_name = "async_fifo",
        input_node = "xxx",
        output_node = "xxx",
        specification = "xxx"
    )

    prompt = read_markdown(prompt_paths['homework1'])
    prompt = replace_prompt(prompt, async_fifo.get_replacement())
    
    print("\n\n\n Get Response:\n")
    
    response = DeepSeek_R1.get_answer( 
        request = prompt,
        system_prompt = None,
        supplement = None,
        stream = True,
        is_reason = False,
        is_print = True
    )

    RTL = extract_code(response, "RTL", "verilog")
    TestBench = extract_code(response, "TestBench", "systemverilog")
    
    async_fifo.rtl_code = RTL
    async_fifo.testbench_code = TestBench
    async_fifo.save_all_componet()