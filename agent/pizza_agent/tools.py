"""The only things an ordering agent can do, whatever harness drives it.

Every tool is a call to the commerce API with the agent token. That token can read the menu,
create a server-priced proposal and read the status of this conversation's orders. Nothing here
(and nothing the API accepts from an agent) can create an order, set a price or take a payment.
"""

from __future__ import annotations

from typing import Any

import httpx


def euros(cents: int) -> str:
    return f"€{cents / 100:.2f}"


class CommerceTools:
    def __init__(self, client: httpx.AsyncClient, conversation_id: str) -> None:
        self._client = client
        self._conversation_id = conversation_id
        self._menu: dict[str, Any] | None = None
        self.calls = 0
        self.proposal_id: str | None = None

    async def menu(self) -> dict[str, Any]:
        if self._menu is None:
            res = await self._client.get("/api/menu")
            res.raise_for_status()
            self._menu = res.json()
        return self._menu

    async def get_menu(self) -> str:
        self.calls += 1
        menu = await self.menu()
        lines: list[str] = []
        for category, title in (("pizza", "Pizzas (normal / large)"), ("drink", "Drinks")):
            lines.append(f"{title}:")
            for p in menu["products"]:
                if p["category"] != category:
                    continue
                price = euros(p["priceCents"])
                if p.get("priceLargeCents") is not None:
                    price += f" / {euros(p['priceLargeCents'])}"
                line = f"- {p['id']}: {p['name']} — {p['description']}. {price}."
                if p["removable"]:
                    removable = ", ".join(f"{r['name']} ({r['id']})" for r in p["removable"])
                    line += f" Can be left out: {removable}."
                lines.append(line)
        lines.append(
            f"Delivery costs {euros(menu['deliveryFeeCents'])} within {menu['deliveryRadiusKm']} km "
            f"of {menu['restaurant']['name']}. Pickup is free."
        )
        return "\n".join(lines)

    async def propose_order(
        self,
        items: list[dict[str, Any]],
        fulfillment: str,
        customer_name: str | None = None,
        phone: str | None = None,
        address: str | None = None,
    ) -> str:
        self.calls += 1
        body = {
            "conversationId": self._conversation_id,
            "fulfillment": fulfillment,
            "items": [
                {
                    "productId": i.get("product_id") or i.get("productId"),
                    "size": i.get("size") or "normal",
                    "quantity": i.get("quantity") or 1,
                    "without": i.get("without") or [],
                }
                for i in items
            ],
            "customerName": customer_name or None,
            "phone": phone or None,
            "address": address or None,
        }
        res = await self._client.post("/api/agent/proposals", json=body)
        if res.status_code == 400:
            # A business rule said no (unknown product, not removable, ...): the agent can fix it.
            return f"The proposal was rejected: {res.json().get('error', 'invalid order')}. Fix it and try again."
        res.raise_for_status()
        proposal = res.json()
        self.proposal_id = proposal["id"]
        return (
            f"Proposal created: {describe_items(proposal['items'])}. "
            f"{'Delivery' if proposal['fulfillment'] == 'delivery' else 'Pickup'}, "
            f"total {euros(proposal['totalCents'])}"
            + (f" including {euros(proposal['deliveryFeeCents'])} delivery" if proposal["deliveryFeeCents"] else "")
            + ". The customer now sees a card where they check the details, confirm and pay. "
            "The order does not exist until they confirm."
        )

    async def get_order_status(self) -> str:
        self.calls += 1
        res = await self._client.get(f"/api/agent/conversations/{self._conversation_id}/orders")
        res.raise_for_status()
        orders = res.json()["orders"]
        if not orders:
            return "No orders have been placed in this conversation yet."
        return "\n".join(
            f"Order {o['ref']}: {STATUS_TEXT.get(o['status'], o['status'])}"
            + (f" ({o['cancelReason']})" if o.get("cancelReason") else "")
            + (f", total {euros(o['totalCents'])}" if o.get("totalCents") is not None else "")
            for o in orders
        )


STATUS_TEXT = {
    "created": "received, being checked",
    "awaiting_payment": "waiting for payment",
    "paid": "paid, waiting for the kitchen to confirm",
    "preparing": "in the oven",
    "ready": "ready",
    "out_for_delivery": "out for delivery",
    "completed": "completed",
    "cancelled": "cancelled",
}


def describe_items(items: list[dict[str, Any]]) -> str:
    parts = []
    for i in items:
        details = []
        if i.get("size") == "large":
            details.append("large")
        if i.get("withoutNames"):
            details.append("no " + ", ".join(n.lower() for n in i["withoutNames"]))
        parts.append(f"{i['quantity']} × {i['name']}" + (f" ({', '.join(details)})" if details else ""))
    return ", ".join(parts)
