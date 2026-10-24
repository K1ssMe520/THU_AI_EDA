#!/usr/bin/env python3
"""示例 Skill：复杂算术 / 线性方程组求解器。

协议：从 stdin 读取一个 JSON 对象，向 stdout 打印一个 JSON 对象。
支持两种参数（二选一）：
  {"expression": "sqrt(2) + 3**2"}       -> {"ok": true, "value": ...}
  {"system": {"A": [[2,1],[1,3]], "b": [5,10]}} -> {"ok": true, "solution": [...]}
本文件故意只使用标准库，方便学生对照并在工作台里修改。
"""

from __future__ import annotations

import ast
import json
import math
import sys
from typing import Any


ALLOWED_FUNCTIONS = {
    "abs": abs,
    "round": round,
    "min": min,
    "max": max,
    "sqrt": math.sqrt,
    "exp": math.exp,
    "log": math.log,
    "log10": math.log10,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "asin": math.asin,
    "acos": math.acos,
    "atan": math.atan,
    "floor": math.floor,
    "ceil": math.ceil,
}
CONSTANTS = {"pi": math.pi, "e": math.e, "tau": math.tau}


def evaluate_expression(expression: str) -> float:
    """只允许数值、括号、算术运算和一组白名单数学函数。"""

    def visit(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise ValueError("表达式只能包含数字常量")
            return float(node.value)
        if isinstance(node, ast.Name):
            if node.id not in CONSTANTS:
                raise ValueError(f"未知常量：{node.id}")
            return float(CONSTANTS[node.id])
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp):
            left = visit(node.left)
            right = visit(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            if isinstance(node.op, ast.FloorDiv):
                return left // right
            if isinstance(node.op, ast.Mod):
                return left % right
            if isinstance(node.op, ast.Pow):
                if abs(right) > 64:
                    raise ValueError("指数过大")
                return left ** right
            raise ValueError("不支持的运算符")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            function = ALLOWED_FUNCTIONS.get(node.func.id)
            if function is None or node.keywords or len(node.args) != 1:
                raise ValueError(f"不支持的函数调用：{node.func.id}")
            return float(function(visit(node.args[0])))
        raise ValueError("表达式包含不允许的语法")

    return visit(ast.parse(expression, mode="eval"))


def solve_linear_system(system: Any) -> list[float]:
    """用带主元的高斯消元求解稠密线性方程组。"""
    if not isinstance(system, dict):
        raise ValueError("system 必须是包含 A 和 b 的对象")
    matrix = system.get("A")
    vector = system.get("b")
    if not isinstance(matrix, list) or not isinstance(vector, list):
        raise ValueError("system 必须包含数组 A 与 b")
    n = len(matrix)
    if n == 0 or len(vector) != n:
        raise ValueError("A 与 b 的维度不匹配")
    rows: list[list[float]] = []
    for index, row in enumerate(matrix):
        if not isinstance(row, list) or len(row) != n:
            raise ValueError("A 必须是 n x n 矩阵")
        rows.append([float(value) for value in row] + [float(vector[index])])

    for column in range(n):
        pivot = max(range(column, n), key=lambda row: abs(rows[row][column]))
        if abs(rows[pivot][column]) < 1e-12:
            raise ValueError("矩阵奇异，无法求解")
        rows[column], rows[pivot] = rows[pivot], rows[column]
        pivot_value = rows[column][column]
        rows[column] = [value / pivot_value for value in rows[column]]
        for row in range(n):
            if row == column:
                continue
            factor = rows[row][column]
            if factor == 0:
                continue
            rows[row] = [
                rows[row][index] - factor * rows[column][index]
                for index in range(n + 1)
            ]
    return [round(rows[row][n], 12) for row in range(n)]


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("输入必须是 JSON 对象")
        if "system" in payload:
            result = {"ok": True, "solution": solve_linear_system(payload["system"])}
        elif "expression" in payload:
            result = {"ok": True, "value": evaluate_expression(str(payload["expression"]))}
        else:
            raise ValueError("请提供 expression 或 system 参数")
    except Exception as error:  # noqa: BLE001 - 将错误结构化返回给 Agent
        result = {"ok": False, "error": str(error)}
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
