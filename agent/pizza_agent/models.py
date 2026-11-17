"""Data passed between the API, the conversation workflow and the agent activity.

Plain dataclasses with snake_case fields: they cross the language boundary as JSON
(the TypeScript API starts the workflow and reads the turn result).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ChatMessage:
    role: str  # "user" | "agent"
    content: str


@dataclass
class ConversationInput:
    conversation_id: str
    history: list[ChatMessage] = field(default_factory=list)
    harness: str | None = None


@dataclass
class TurnInput:
    conversation_id: str
    history: list[ChatMessage]
    message: str
    harness: str | None = None


@dataclass
class TurnResult:
    reply: str
    proposal_id: str | None = None
    harness: str = ""
    model: str | None = None
    outcome: str = "replied"  # "replied" | "proposed" | "failed"
    tool_calls: int = 0
    blocked_tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int = 0
