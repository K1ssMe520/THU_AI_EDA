"""固定 Agent 流程的受限 EDA 自动设计执行器。

固定流水线：Parser → RTL Planner → Coder → Tester → Modifier（失败回环）。
Parser 需要补充 Spec 时通过 ``request_input`` 暂停并等待用户输入。
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ai_eda.agent.projects import get_project
from ai_eda.agent.runs import (
    AgentCancelled,
    _now,
    _report_summary,
    _run_payload,
    _write_json,
    _write_metadata,
    agent_task_spec,
    load_agent_graph,
)
from ai_eda.agent.subagents.base import RunContext
from ai_eda.agent.subagents.coder import CoderAgent
from ai_eda.agent.subagents.modifier import ModifierAgent
from ai_eda.agent.subagents.parser import ParserAgent
from ai_eda.agent.subagents.planner import PlannerAgent
from ai_eda.agent.subagents.tester import TesterAgent
from ai_eda.config import AGENT_RUNS_ROOT

EventSink = Callable[[dict[str, Any]], None]


def _check_cancel(cancel_event: Any) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise AgentCancelled("Agent 运行已取消。")


def run_agent(
    *,
    thinking: bool = True,
    reasoning_effort: str = "low",
    temperature: float = 0.2,
    max_tokens: int = 30000,
    max_calls: int = 100,
    on_event: EventSink | None = None,
    cancel_event: Any = None,
    design_id: str | None = None,
    design_name: str | None = None,
    project_id: str | None = None,
    request_input: Callable[[dict[str, Any]], str] | None = None,
) -> dict[str, Any]:
    """运行固定流水线：Parser → Planner → Coder → Tester ⇄ Modifier。

    ``graph.json`` 只是该固定流程的只读可视化，不参与调度。每个 Agent 都从上游
    handoff 中取得 artifact 引用，再按引用读取 Spec、RTL 或报告内容。
    """
    graph = load_agent_graph()
    if reasoning_effort not in {"low", "high", "max"}:
        raise ValueError("reasoning_effort 无效")
    if not 1 <= int(max_calls) <= 1000:
        raise ValueError("max_calls 必须在 1 到 1000 之间")
    project = get_project(project_id)
    spec_base = agent_task_spec(project["id"])
    run_id = f"agent-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"
    run_dir = AGENT_RUNS_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    _write_json(run_dir / "graph.json", graph)
    (run_dir / "project").mkdir(exist_ok=True)

    events: list[dict[str, Any]] = []
    started_at = _now()
    started_clock = time.perf_counter()
    current_status = "running"
    final_report: dict[str, Any] | None = None
    final_result: dict[str, Any] | None = None
    effective_spec = spec_base
    parser_result: dict[str, Any] = {}
    plan: dict[str, Any] | None = None
    files: list[dict[str, Any]] = []
    tester_attempts = 0

    def persist(status: str = "running", error: str | None = None) -> None:
        _write_json(
            run_dir / "events.json",
            _run_payload(
                run_id=run_id,
                run_dir=run_dir,
                graph=graph,
                events=events,
                status=status,
                started_at=started_at,
                report=final_report,
                result=final_result,
                spec=effective_spec,
                error=error,
                design_id=design_id,
                design_name=design_name,
                project_id=project["id"],
            ),
        )

    def emit(event: dict[str, Any]) -> None:
        if on_event is not None:
            on_event(json.loads(json.dumps(event, ensure_ascii=False)))

    def begin_event(
        node_id: str, node_type: str, title: str, prompt: str, attempt: int = 1
    ) -> dict[str, Any]:
        event: dict[str, Any] = {
            "run_id": run_id,
            "step": len(events) + 1,
            "node_id": node_id,
            "node_type": node_type,
            "title": title,
            "prompt": prompt,
            "status": "running",
            "attempt": attempt,
            "started_at": _now(),
            "_started_clock": time.perf_counter(),
        }
        events.append(event)
        persist()
        emit(event)
        return event

    def finish_event(event: dict[str, Any], status: str, **fields: Any) -> None:
        event.update(fields)
        event["status"] = status
        event["duration_ms"] = round(
            (time.perf_counter() - event.get("_started_clock", time.perf_counter())) * 1000
        )
        event.pop("_started_clock", None)
        event["finished_at"] = _now()
        persist()
        emit(event)

    def check_cancel() -> None:
        _check_cancel(cancel_event)

    persist()
    try:
        context = RunContext(
            run_dir=run_dir,
            options={
                "temperature": temperature,
                "max_tokens": max_tokens,
                "thinking": thinking,
                "reasoning_effort": reasoning_effort,
                "project": project,
            },
            begin_event=begin_event,
            finish_event=finish_event,
            persist=persist,
            emit=emit,
            check_cancel=check_cancel,
            request_input=request_input,
            max_calls=max_calls,
        )
        spec_ref = context.write_text_artifact("spec.md", spec_base)
        initial_handoff = context.write_handoff(
            "spec",
            "parser",
            {"task": project["id"], "artifacts": {"spec": spec_ref}},
            label="固定 Spec → Parser：Spec artifact",
        )

        parser = ParserAgent(context)
        parser_handoff = parser.run(initial_handoff)

        planner = PlannerAgent(context)
        planner_handoff = planner.run(parser_handoff)

        coder = CoderAgent(context)
        next_tester_input = coder.run(planner_handoff)

        tester = TesterAgent(context)
        modifier = ModifierAgent(context)
        while True:
            tester_attempts += 1
            tester_handoff = tester.run(next_tester_input, tester_attempts)
            tester_payload = context.read_handoff(tester_handoff)["payload"]
            tester_artifacts = tester_payload.get("artifacts") or {}
            report_ref = tester_artifacts.get("report")
            if not isinstance(report_ref, str):
                raise ValueError("Tester handoff 缺少报告 artifact")
            report = context.read_json_artifact(report_ref)
            if not isinstance(report, dict):
                raise ValueError("Tester 报告 artifact 格式无效")
            final_report = report
            if report.get("passed"):
                break
            if tester_attempts >= 3:
                break
            check_cancel()
            next_tester_input = modifier.run(tester_handoff, tester_attempts)

        if final_report is None:
            raise ValueError("Tester 没有产出验收报告")
        final_handoff = context.read_handoff(tester_handoff)["payload"]
        final_artifacts = final_handoff.get("artifacts") or {}
        spec_ref = final_artifacts.get("spec")
        plan_ref = final_artifacts.get("plan")
        manifest_ref = final_artifacts.get("rtl_manifest")
        if not all(isinstance(ref, str) for ref in (spec_ref, plan_ref, manifest_ref)):
            raise ValueError("最终 handoff 缺少 Spec、Plan 或 RTL manifest artifact")
        effective_spec = context.read_text_artifact(spec_ref)
        plan = context.read_json_artifact(plan_ref)
        manifest = context.read_json_artifact(manifest_ref)
        if not isinstance(plan, dict) or not isinstance(manifest, dict):
            raise ValueError("最终 artifact 格式无效")
        files = manifest.get("files") if isinstance(manifest.get("files"), list) else []
        parser_payload = context.read_handoff(parser_handoff)["payload"]
        parser_result_ref = (parser_payload.get("artifacts") or {}).get("parser_result")
        if isinstance(parser_result_ref, str):
            parsed = context.read_json_artifact(parser_result_ref)
            parser_result = parsed if isinstance(parsed, dict) else {}
        passed = bool(final_report.get("passed"))
        final_result = {
            "passed": passed,
            "stage": final_report.get("stage"),
            "summary": _report_summary(final_report),
            "metrics": final_report.get("metrics") or {},
            "spec": effective_spec,
            "plan": plan,
            "files": files,
            "parser_rounds": parser_result.get("rounds", 1),
            "supplements": parser_result.get("supplements", []),
            "tester_attempts": tester_attempts,
            "cpu_capability": final_report.get("cpu_capability"),
            "test_suites": final_report.get("test_suites"),
            "performance": final_report.get("performance"),
        }
        _write_json(run_dir / "result.json", final_result)
        current_status = "passed" if passed else "failed"
    except AgentCancelled as error:
        current_status = "cancelled"
        for pending in events:
            if pending.get("status") in {"running", "waiting_input"}:
                pending.update(
                    {"status": "cancelled", "finished_at": _now(), "error": str(error)}
                )
        payload = _run_payload(
            run_id=run_id,
            run_dir=run_dir,
            graph=graph,
            events=events,
            status=current_status,
            started_at=started_at,
            finished_at=_now(),
            report=final_report,
            result=final_result,
            spec=effective_spec,
            error=str(error),
            design_id=design_id,
            design_name=design_name,
            project_id=project["id"],
        )
        payload["duration_ms"] = round((time.perf_counter() - started_clock) * 1000)
        _write_json(run_dir / "events.json", payload)
        try:
            _write_metadata(
                run_dir,
                graph=graph,
                run_id=run_id,
                status=current_status,
                started_at=started_at,
                finished_at=payload["finished_at"],
                attempts=tester_attempts or 1,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                reasoning_effort=reasoning_effort,
                design_id=design_id,
                design_name=design_name,
                project_id=project["id"],
            )
        except Exception:
            pass
        raise
    except Exception as error:
        current_status = "failed"
        for pending in events:
            if pending.get("status") in {"running", "waiting_input"}:
                pending.update(
                    {"status": "failed", "finished_at": _now(), "error": str(error)}
                )
        payload = _run_payload(
            run_id=run_id,
            run_dir=run_dir,
            graph=graph,
            events=events,
            status=current_status,
            started_at=started_at,
            finished_at=_now(),
            report=final_report,
            result=final_result,
            spec=effective_spec,
            error=str(error),
            design_id=design_id,
            design_name=design_name,
            project_id=project["id"],
        )
        payload["duration_ms"] = round((time.perf_counter() - started_clock) * 1000)
        _write_json(run_dir / "events.json", payload)
        try:
            _write_metadata(
                run_dir,
                graph=graph,
                run_id=run_id,
                status=current_status,
                started_at=started_at,
                finished_at=payload["finished_at"],
                attempts=tester_attempts or 1,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                reasoning_effort=reasoning_effort,
                design_id=design_id,
                design_name=design_name,
                project_id=project["id"],
            )
        except Exception:
            pass
        raise

    payload = _run_payload(
        run_id=run_id,
        run_dir=run_dir,
        graph=graph,
        events=events,
        status=current_status,
        started_at=started_at,
        finished_at=_now(),
        report=final_report,
        result=final_result,
        spec=effective_spec,
        design_id=design_id,
        design_name=design_name,
        project_id=project["id"],
    )
    payload["duration_ms"] = round((time.perf_counter() - started_clock) * 1000)
    _write_json(run_dir / "events.json", payload)
    _write_metadata(
        run_dir,
        graph=graph,
        run_id=run_id,
        status=current_status,
        started_at=started_at,
        finished_at=payload["finished_at"],
        attempts=tester_attempts or 1,
        temperature=temperature,
        max_tokens=max_tokens,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        design_id=design_id,
        design_name=design_name,
        project_id=project["id"],
    )
    return payload



