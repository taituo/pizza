"""Middleware that keeps a Deep Agent inside the commerce tools.

Deep Agents ships with a filesystem, a shell-capable backend, todo lists and sub-agents. An agent
that talks to customers needs none of them, so the guard does two things: the model is only ever
shown the allowed tools, and a call to anything else is answered with an error instead of being
executed. It is defence in depth, not the security boundary: the API would refuse anything outside
the agent token's scope even if this middleware were missing.
"""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage


def _tool_name(tool: Any) -> str | None:
    if isinstance(tool, dict):
        return tool.get("name") or tool.get("function", {}).get("name")
    return getattr(tool, "name", None)


class CommerceGuard(AgentMiddleware):
    def __init__(self, allowed: set[str]) -> None:
        super().__init__()
        self.allowed = set(allowed)
        self.blocked: list[str] = []

    def _visible(self, request: Any) -> Any:
        return request.override(tools=[t for t in request.tools if _tool_name(t) in self.allowed])

    def _refusal(self, request: Any) -> ToolMessage | None:
        name = request.tool_call["name"]
        if name in self.allowed:
            return None
        self.blocked.append(name)
        return ToolMessage(
            content=f"The tool {name} is not available to you. Use only: {', '.join(sorted(self.allowed))}.",
            tool_call_id=request.tool_call["id"],
            name=name,
            status="error",
        )

    def wrap_model_call(self, request, handler):  # type: ignore[override]
        return handler(self._visible(request))

    async def awrap_model_call(self, request, handler):  # type: ignore[override]
        return await handler(self._visible(request))

    def wrap_tool_call(self, request, handler):  # type: ignore[override]
        return self._refusal(request) or handler(request)

    async def awrap_tool_call(self, request, handler):  # type: ignore[override]
        return self._refusal(request) or await handler(request)
