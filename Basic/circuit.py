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
            'TestBench_code': self.testbench_code,
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
        file_path = os.path.join(self.testbench_path, f"{self.model_name}_tb.sv")
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

