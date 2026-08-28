"""Keep legacy route tests focused on their original behavior.

Trust-boundary behavior is exercised explicitly in test_security_runtime.py.
"""
import pytest

import app as app_module


@pytest.fixture(autouse=True)
def collector_test_mode():
    old_testing = app_module.app.config.get("TESTING")
    old_bypass = app_module.app.config.get("COLLECTOR_AUTH_BYPASS_TESTS")
    app_module.app.config.update(TESTING=True, COLLECTOR_AUTH_BYPASS_TESTS=True)
    try:
        yield
    finally:
        app_module.app.config["TESTING"] = old_testing
        if old_bypass is None:
            app_module.app.config.pop("COLLECTOR_AUTH_BYPASS_TESTS", None)
        else:
            app_module.app.config["COLLECTOR_AUTH_BYPASS_TESTS"] = old_bypass
