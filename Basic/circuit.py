from dataclasses import dataclass, asdict
import os
import json
import subprocess

@dataclass
class CIRCUIT:
    model_name: str = None
    input_node: str = None
    output_node: str = None
    specification: str = None
    rtl_code: str = None
    testbench_code: str = None
    test_spec: str = None
    RelatedID: list = None
    SimulationResult: str = None

    def __post_init__(self):
        self.json_path = './Json'
        self.rtl_path = './RTL'
        self.testbench_path = './Test'

    def get_replacement(self):
        replacement = {
            'ModelName': self.model_name,
            'InputNode': self.input_node,
            'OutputNode': self.output_node,
            'Specification': self.specification,
            'RTLCode': self.rtl_code,
            'TestSpec': self.test_spec,
            'TestBench_code': self.testbench_code,
            'SimulationResult': self.SimulationResult,
        }
        return replacement

    def save_all_componet(self):
        self.save_json()
        self.save_rtl()
        self.save_testbench()
            

    def save_json(self):
        file_path = os.path.join(self.json_path, f"{self.model_name}.json")
        try:
            model_dict = asdict(self)
            with open(file_path, 'w') as file:
                json.dump(model_dict, file, indent=4)
            print(f"Model saved successfully to {file_path}")
        except Exception as e:
            print(f"Failed to save model: {e}")

    def save_rtl(self):
        if self.rtl_code == None: return
        file_path = os.path.join(self.rtl_path, f"{self.model_name}.v")
        try:
            with open(file_path, 'w') as file:
                file.write(self.rtl_code)
            print(f"RTL saved successfully to {file_path}")
        except Exception as e:
            print(f"Fail to save rtl to {file_path}")

    def save_testbench(self):
        if self.testbench_code == None: return
        file_path = os.path.join(self.testbench_path, f"tb_{self.model_name}.sv")
        try:
            with open(file_path, 'w') as file:
                file.write(self.testbench_code)
            print(f"TestBench saved successfully to {file_path}")
        except Exception as e:
            print(f"Fail to save TestBench to {file_path}")

    @staticmethod
    def load_circuit(file_path: str):
        try:
            with open(file_path, 'r') as file:
                model_dict = json.load(file)
                model = CIRCUIT()
                model.__dict__.update(model_dict)
            print(f"Circuit loaded successfully from {file_path}")
            return model
        except Exception as e:
            print(f"Failed to load Circuit: {e}")
            return None

    def execute_testbench(self):
        self.save_rtl()
        self.save_testbench()

        simulate_cmd = ['python', './Scripts/simulate.py', f'tb_{self.model_name}', f'tb_{self.model_name}.sv', f'{self.model_name}.v']

        if self.RelatedID != None:
            for id in self.RelatedID:
                simulate_cmd += [str(id) + " "]

        # print(simulate_cmd)

        result = subprocess.run(simulate_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        self.SimulationResult = result.stdout + result.stderr

        print("\n\nSimulate the RTL, the simulation result is :\n", self.SimulationResult)



class SUBMODULE:
    def __init__(self, module_name: str):
        self.module_name = module_name
        module_path = os.path.join('RTL/SubModule', module_name+'.v')

        try:
            with open(module_path, "r", encoding="utf-8") as file:
                self.RTL = file.read()
        except Exception as e:
            self.RTL = None
            print(f"Failed to load submodule {self.module_name} {e}")

    def get_RTL_text(self):
        return f"\n\n#### {self.module_name}\n```verilog\n{self.RTL}\n```"


submodule_set = {
    '1': SUBMODULE('Multiplexer'),
    '2': SUBMODULE('Decoder'),
    '3': SUBMODULE('Encoder'),
    '4': SUBMODULE('FullAdder'),
    '5': SUBMODULE('RippleCarryAdder'),
    '6': SUBMODULE('CarryLookaheadAdder'),
    '7': SUBMODULE('ArrayMultiplier'),
    '8': SUBMODULE('Comparator'),
    '9': SUBMODULE('DFlipFlop'),
    '10': SUBMODULE('Register'),
    '11': SUBMODULE('ShiftRegister'),
    '12': SUBMODULE('Counter'),
    '13': SUBMODULE('FIFO'),
    '14': SUBMODULE('ClockDivider'),
    '15': SUBMODULE('Synchronizer')}