import re

def read_markdown(file_path: str, is_print: bool=False) -> str:
    try:
        with open(file_path, "r", encoding="utf-8") as file:
            prompt = file.read()
            if is_print:
                print(prompt)
            return prompt

    except Exception as e:
        print(f"Failed to read file: {e}")
        return ""


def extract_code(text: str, segment_leader: str, code_leader: str):
    pattern = re.compile(
        r'###\s+' + re.escape(segment_leader) + r'\s*' + 
        r'```' + re.escape(code_leader) + r'\n(.*?)```',
        re.DOTALL
    )
    match = pattern.search(text)
    if match:
        return match.group(1).strip()
    return None

def write_file(text: str, path: str):
    with open(path, "w", encoding="utf-8") as file:
        file.write(text)

def replace_prompt(text: str, replacements: dict, is_print: bool=True)->str:
    for key, value in replacements.items():
        if value != None:
            placeholder = f"[{key}]"
            text = text.replace(placeholder, value)
    
    if is_print:
        print(f"Prompt:\n{text}")
    
    return text
