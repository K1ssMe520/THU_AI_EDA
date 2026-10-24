.PHONY: clean clean-runs web

# 删除模型调用产生的全部实验记录；任务、Prompt 与测试平台均不受影响。
clean: clean-runs

clean-runs:
	rm -rf -- prompt_optimization/runs

# 启动仅监听本机的可视化工作台。
web:
	.venv/bin/python -m common serve --host 127.0.0.1 --port 8000
