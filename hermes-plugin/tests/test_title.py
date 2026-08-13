"""Session title cleaning and state.db resolution."""
import importlib.util
import json
import sqlite3
from pathlib import Path

PLUGIN = Path(__file__).parents[1] / "__init__.py"
spec = importlib.util.spec_from_file_location("telegram_canvas_plugin", PLUGIN)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def test_clean_title_keeps_usable_title():
    assert plugin.cleanTitle("Build the dashboard", "advait", 0) == "Build the dashboard"


def test_clean_title_rejects_prompt_and_shell_titles(monkeypatch):
    monkeypatch.setattr(plugin, "datetime", __import__("datetime").datetime)
    for value in ("[Note: model switched]", "[Replying to: hello]", "[advait] task", "System information as of today", "ls -la"):
        assert plugin.cleanTitle(value, "advait", 0).startswith("advait · ")
    assert plugin.cleanTitle("x" * 91, "advait", 0).startswith("advait · ")


def test_clean_title_falls_back_to_now_without_timestamp(monkeypatch):
    class FrozenDate:
        @classmethod
        def now(cls):
            return cls()

        def strftime(self, fmt):
            return "Jan 02"

    monkeypatch.setattr(plugin, "datetime", FrozenDate)
    assert plugin.cleanTitle("", "", None) == "Chat · Jan 02"


def test_read_session_metadata_uses_read_only_sqlite(monkeypatch, tmp_path):
    db_path = tmp_path / ".hermes" / "state.db"
    db_path.parent.mkdir()
    db = sqlite3.connect(db_path)
    db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, display_name TEXT, last_activity_at REAL)")
    db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", ("sid", "Stored title", "advait", 1700000000))
    db.commit()
    db.close()
    monkeypatch.setenv("HOME", str(tmp_path))

    assert plugin._read_session_metadata("sid") == ("Stored title", "advait", 1700000000.0)
    assert plugin._read_session_metadata("missing") == ("", "", None)
    assert json.loads(json.dumps(plugin._read_session_metadata("sid"), default=str))
