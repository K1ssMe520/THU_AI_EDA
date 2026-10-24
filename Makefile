.PHONY: clean clean-runs web

# 删除模型调用产生的全部实验记录；内容、测试平台与代码均不受影响。
clean: clean-runs

clean-runs:
	rm -rf -- runs

# 启动仅监听本机的可视化工作台。
web:
	.venv/bin/python -m ai_eda serve --host 127.0.0.1 --port 8000
