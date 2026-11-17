"""Agent harnesses behind one small interface.

The conversation workflow and the commerce API do not know which harness answers. Swapping
Deep Agents for something else, or running two side by side, changes nothing outside this package.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..models import TurnInput
from ..tools import CommerceTools


@dataclass
class HarnessReply:
    reply: str
    model: str | None = None
    blocked_tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0


class Harness(Protocol):
    name: str

    async def run(self, turn: TurnInput, tools: CommerceTools) -> HarnessReply: ...
