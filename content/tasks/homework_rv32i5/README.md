# RV32I 四层设计作业

同一 RV32I 子集与教师测试入口，按累加功能划分四个 Agent 项目。基础 Spec 保留原先零等待五级流水接口，高级层使用统一握手与观察接口；三套高级 Spec 包含完整基础内容，交给 Planner 时无需再拼接其他文件。

| Agent 项目 | 目标 | Spec | 能力声明 |
|---|---|---|---|
| `rv32i5` | L0 基础五级流水、前递、load-use、EX 分支恢复 | `spec.md` | 无高级端口 |
| `rv32i5_cache` | L1：基础 + I/D Cache | `specs/cache.md` | `001` |
| `rv32i5_predict` | L2：L1 + 动态 BTB/BHT | `specs/predict.md` | `011` |
| `rv32i5_ooo` | L3：L2 + 重命名、乱序执行、ROB 提交 | `specs/ooo.md` | `111` |

高级层 Cache 固定为每个 256 bytes、16-byte line、直接映射，D-Cache 采用 write-through / write-allocate。每次外部总线握手只接受一个 32-bit word；TB 可插入等待，检查 refill、重复命中与冲突替换。预测层要求 16 项 BTB + 16 项 2-bit BHT；乱序层最低为 8 项 ROB、8 项 IQ、40 个物理寄存器与 2 项内存队列，并允许独立 ALU 越过更老的未完成 load。

所有项目共用 `tb.sv`、`power_tb.sv` 的教师入口与同一套程序，先验收基础架构结果，再叠加扩展测试。`expected_cpu_level` 是所选课程目标，`dbg_features` 是 RTL 的能力声明；测试报告的行为验证层次应独立列出，声明位不能替代验收。层级顺序是累加的，未通过 Cache 时不能只凭预测事件取得 L2。

退休事件用于 CPI/IPC，外部接受事务用于内存流量，预测与乱序事件用于解释微架构收益。有限黑盒测试不能证明内部 ROB / PRF 等容量与全部实现细节，结构要求还需代码与综合检查。教学缩小的 CoreMark 风格内核只能报告教学负载的周期/IPC，不能标为官方 CoreMark 分数。

设计难点逐层增加：L1 的 miss、回填、局部暂停与复位并发；L2 的预测元数据、错误目标恢复与错误路径副作用；L3 的重命名生命周期、队列压力、顺序提交、内存顺序和误预测恢复。架构结果、真实行为与性能三者分别记录，便于比较模型在哪类状态组合上失误。
