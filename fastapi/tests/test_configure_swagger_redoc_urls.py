"""Test configurable CDN URLs for Swagger UI and ReDoc at the FastAPI app level."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html


def test_swagger_ui_default_cdn_urls():
    """Default CDN URLs should be used when not overridden."""
    app = FastAPI()

    @app.get("/items")
    def get_items():
        return {"items": []}

    client = TestClient(app)
    response = client.get("/docs")
    assert response.status_code == 200
    assert "cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" in response.text
    assert "cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" in response.text
    assert "fastapi.tiangolo.com/img/favicon.png" in response.text


def test_redoc_default_cdn_urls():
    """Default CDN URLs should be used for ReDoc when not overridden."""
    app = FastAPI()

    @app.get("/items")
    def get_items():
        return {"items": []}

    client = TestClient(app)
    response = client.get("/redoc")
    assert response.status_code == 200
    assert "cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js" in response.text
    assert "fastapi.tiangolo.com/img/favicon.png" in response.text
    assert "fonts.googleapis.com/css?family=Montserrat" in response.text


def test_swagger_ui_custom_cdn_urls():
    """Custom CDN URLs should be used when provided to FastAPI app."""
    app = FastAPI(
        swagger_js_url="/static/swagger-ui-bundle.js",
        swagger_css_url="/static/swagger-ui.css",
        swagger_favicon_url="/static/favicon.png",
    )

    @app.get("/items")
    def get_items():
        return {"items": []}

    client = TestClient(app)
    response = client.get("/docs")
    assert response.status_code == 200
    assert "/static/swagger-ui-bundle.js" in response.text
    assert "/static/swagger-ui.css" in response.text
    assert "/static/favicon.png" in response.text
    assert "cdn.jsdelivr.net" not in response.text


def test_redoc_custom_cdn_urls():
    """Custom CDN URLs should be used for ReDoc when provided to FastAPI app."""
    app = FastAPI(
        redoc_js_url="/static/redoc.standalone.js",
        redoc_favicon_url="/static/redoc-favicon.png",
        redoc_google_fonts_url="/static/fonts/custom.css",
    )

    @app.get("/items")
    def get_items():
        return {"items": []}

    client = TestClient(app)
    response = client.get("/redoc")
    assert response.status_code == 200
    assert "/static/redoc.standalone.js" in response.text
    assert "/static/redoc-favicon.png" in response.text
    assert "/static/fonts/custom.css" in response.text
    assert "cdn.jsdelivr.net" not in response.text
    assert "fonts.googleapis.com" not in response.text


def test_redoc_google_fonts_url_parameter():
    """The google_fonts_url parameter should be configurable in get_redoc_html."""
    html = get_redoc_html(
        openapi_url="/openapi.json",
        title="Test API",
        google_fonts_url="/static/fonts/custom.css",
    )
    body = html.body.decode()
    assert "/static/fonts/custom.css" in body
    assert "fonts.googleapis.com" not in body


def test_redoc_google_fonts_disabled():
    """Google Fonts should not be included when with_google_fonts=False."""
    html = get_redoc_html(
        openapi_url="/openapi.json",
        title="Test API",
        with_google_fonts=False,
        google_fonts_url="/static/fonts/custom.css",
    )
    body = html.body.decode()
    assert "fonts.googleapis.com" not in body
    assert "/static/fonts/custom.css" not in body


def test_fastapi_cdn_url_attributes():
    """FastAPI app should store CDN URL parameters as attributes."""
    app = FastAPI(
        swagger_js_url="/custom/swagger.js",
        swagger_css_url="/custom/swagger.css",
        swagger_favicon_url="/custom/favicon.ico",
        redoc_js_url="/custom/redoc.js",
        redoc_favicon_url="/custom/redoc-favicon.ico",
        redoc_google_fonts_url="/custom/fonts.css",
    )
    assert app.swagger_js_url == "/custom/swagger.js"
    assert app.swagger_css_url == "/custom/swagger.css"
    assert app.swagger_favicon_url == "/custom/favicon.ico"
    assert app.redoc_js_url == "/custom/redoc.js"
    assert app.redoc_favicon_url == "/custom/redoc-favicon.ico"
    assert app.redoc_google_fonts_url == "/custom/fonts.css"
