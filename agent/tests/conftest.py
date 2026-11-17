"""A fake commerce API (httpx MockTransport) with the real menu shape, shared by the tests."""

from __future__ import annotations

import json
import uuid

import httpx
import pytest

MENU = {
    "restaurant": {"name": "Golden Sample Pizzeria", "lat": 60.1699, "lng": 24.9384},
    "deliveryFeeCents": 390,
    "deliveryRadiusKm": 8,
    "paymentProvider": "sim",
    "products": [
        {
            "id": "margherita", "name": "Margherita", "description": "Tomato, mozzarella, basil", "category": "pizza",
            "priceCents": 1090, "priceLargeCents": 1490,
            "removable": [{"id": "mozzarella", "name": "Mozzarella"}, {"id": "basil", "name": "Basil"}],
        },
        {
            "id": "pepperoni", "name": "Pepperoni", "description": "Tomato, mozzarella, pepperoni, red onion",
            "category": "pizza", "priceCents": 1290, "priceLargeCents": 1690,
            "removable": [{"id": "mozzarella", "name": "Mozzarella"}, {"id": "pepperoni", "name": "Pepperoni"},
                          {"id": "onion", "name": "Red onion"}],
        },
        {"id": "cola", "name": "Cola", "description": "0.33 l can", "category": "drink",
         "priceCents": 290, "priceLargeCents": None, "removable": []},
        {"id": "water", "name": "Mineral water", "description": "0.33 l bottle", "category": "drink",
         "priceCents": 250, "priceLargeCents": None, "removable": []},
    ],
}  # fmt: skip


class FakeApi:
    def __init__(self) -> None:
        self.proposals: list[dict] = []
        self.requests: list[tuple[str, str]] = []
        self.orders: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        if request.url.path == "/api/menu":
            return httpx.Response(200, json=MENU)
        if request.headers.get("x-agent-token") != "test-agent-token":
            return httpx.Response(401, json={"error": "Agent token is missing or wrong"})
        if request.url.path == "/api/agent/proposals":
            body = json.loads(request.content)
            products = {p["id"]: p for p in MENU["products"]}
            priced = []
            for item in body["items"]:
                product = products.get(item["productId"])
                if not product:
                    return httpx.Response(400, json={"error": f"Product is not available: {item['productId']}"})
                large = item["size"] == "large"
                if large and product["priceLargeCents"] is None:
                    return httpx.Response(400, json={"error": f"{product['name']} is not available in large"})
                unit = product["priceLargeCents"] if large else product["priceCents"]
                names = {r["id"]: r["name"] for r in product["removable"]}
                priced.append({**item, "name": product["name"], "withoutNames": [names[w] for w in item["without"]],
                               "unitPriceCents": unit, "lineTotalCents": unit * item["quantity"]})  # fmt: skip
            fee = 390 if body["fulfillment"] == "delivery" else 0
            proposal = {
                "id": str(uuid.uuid4()), "status": "open", "fulfillment": body["fulfillment"], "items": priced,
                "deliveryFeeCents": fee, "totalCents": sum(i["lineTotalCents"] for i in priced) + fee,
                "request": body,
            }  # fmt: skip
            self.proposals.append(proposal)
            return httpx.Response(201, json=proposal)
        if request.url.path.endswith("/orders"):
            return httpx.Response(200, json={"orders": self.orders})
        return httpx.Response(404, json={"error": "not found"})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url="http://api.test",
            headers={"x-agent-token": "test-agent-token"},
            transport=httpx.MockTransport(self.handler),
        )


@pytest.fixture
def api() -> FakeApi:
    return FakeApi()
