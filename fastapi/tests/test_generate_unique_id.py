"""Tests for generate_unique_id uniqueness across routers."""
from fastapi import APIRouter, FastAPI
from fastapi.utils import generate_unique_id


def _make_router_with_routes(prefix, route_names_and_methods):
    """Helper to create a router with named routes."""
    router = APIRouter(prefix=prefix)

    for name, method in route_names_and_methods:
        if method.lower() == "get":
            router.get("/", name=name)(lambda: None)
        elif method.lower() == "post":
            router.post("/", name=name)(lambda: None)
        elif method.lower() == "put":
            router.put("/", name=name)(lambda: None)
        elif method.lower() == "delete":
            router.delete("/", name=name)(lambda: None)

    return router


def test_same_function_different_prefix_no_collision():
    """Two routers with same function names but different prefixes should not collide."""
    # Reset seen_ids
    generate_unique_id._seen_ids = {}

    router1 = APIRouter(prefix="/api/v1")
    router1.get("/users", name="get_users")(lambda: None)

    router2 = APIRouter(prefix="/api/v2")
    router2.get("/users", name="get_users")(lambda: None)

    app = FastAPI()
    app.include_router(router1)
    app.include_router(router2)

    # Collect all operation IDs
    op_ids = set()
    for route in app.routes:
        if hasattr(route, "operation_id"):
            op_ids.add(route.operation_id)

    # Should have 2 unique operation IDs
    assert len(op_ids) == 2


def test_same_function_same_prefix_different_methods():
    """Same prefix and function name but different HTTP methods should not collide."""
    generate_unique_id._seen_ids = {}

    router = APIRouter(prefix="/items")
    router.get("/item", name="handle_item")(lambda: None)
    router.post("/item", name="handle_item")(lambda: None)
    router.put("/item", name="handle_item")(lambda: None)

    app = FastAPI()
    app.include_router(router)

    op_ids = [route.operation_id for route in app.routes if hasattr(route, "operation_id")]
    assert len(set(op_ids)) == 3


def test_identical_routers_cause_suffix():
    """Identical routers with same function name should get numeric suffix."""
    generate_unique_id._seen_ids = {}

    router1 = APIRouter(prefix="/v1")
    router1.get("/list", name="list_all")(lambda: None)

    router2 = APIRouter(prefix="/v1")
    router2.get("/list", name="list_all")(lambda: None)

    app = FastAPI()
    app.include_router(router1)
    app.include_router(router2)

    op_ids = [route.operation_id for route in app.routes if hasattr(route, "operation_id")]
    # Should have get_v1_list_all and get_v1_list_all_1
    assert len(set(op_ids)) == 2
    assert "get_v1_list_all" in op_ids


def test_operation_id_format():
    """Operation IDs should be lowercase alphanumeric with underscores only."""
    generate_unique_id._seen_ids = {}

    router = APIRouter(prefix="/api/v1/users")
    router.get("/", name="GetUsersList")(lambda: None)

    app = FastAPI()
    app.include_router(router)

    for route in app.routes:
        if hasattr(route, "operation_id"):
            op_id = route.operation_id
            assert re.match(r"^[a-z0-9_]+$", op_id), f"Invalid format: {op_id}"


def test_no_prefix_consistent_format():
    """Routes without prefix should still generate consistent IDs."""
    generate_unique_id._seen_ids = {}

    router = APIRouter()  # No prefix
    router.get("/users", name="get_users")(lambda: None)

    app = FastAPI()
    app.include_router(router)

    for route in app.routes:
        if hasattr(route, "operation_id"):
            op_id = route.operation_id
            assert "get_users" in op_id


import re  # noqa: E402 - needed for test_operation_id_format
