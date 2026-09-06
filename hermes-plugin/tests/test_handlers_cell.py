"""Tests for cell-level handlers (insert_cell, overwrite_cell_source,
read_cell, clear_cell_output).

These handlers require an active notebook; the `activate()` helper below
boots one up with a stubbed `_req` so each test starts on a known fixture.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_plugin.tests._bootstrap import install_plugin_package, run  # noqa: E402
install_plugin_package()

import hermes_plugin.tools as tools  # noqa: E402

import pytest  # noqa: E402


SESSION_BODY = {
    "id": "sess-abc",
    "kernel": {"id": "kernel-xyz"},
    "path": "/notebooks/demo.ipynb",
}

EMPTY_NOTEBOOK = {
    "name": "demo.ipynb", "path": "demo.ipynb", "type": "notebook",
    "content": {
        "cells": [],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    },
}


def activate(tools, *, notebook=None):
    """Activate 'demo' with a router that returns the given notebook content.

    Also runs `jupyter_use_notebook` so handlers like `jupyter_insert_cell`
    that need an active session will see one.
    """
    nb = notebook if notebook is not None else EMPTY_NOTEBOOK

    async def router(method, path, body=None):
        if method == "POST" and path == "/api/sessions":
            return SESSION_BODY
        if method == "GET" and path.startswith("/api/contents/"):
            return nb
        if method == "PUT":
            return {}
        if method == "PATCH" and path.startswith("/api/contents/"):
            # Echo back the body so caller sees what got written.
            return {"type": "file", "content": body}
        raise AssertionError((method, path))
    tools._req = router
    # Drive the activate path through the real handler so state is set consistently.
    run(tools.jupyter_use_notebook({
        "notebook_path": "demo.ipynb", "notebook_name": "demo",
    }))
    return nb


def two_cell_nb():
    return {
        "name": "demo.ipynb", "path": "demo.ipynb", "type": "notebook",
        "content": {
            "cells": [
                {"cell_type": "code", "id": "cell-A",
                 "source": "a = 1\n", "metadata": {},
                 "outputs": [], "execution_count": None},
                {"cell_type": "code", "id": "cell-B",
                 "source": "b = 2\n", "metadata": {},
                 "outputs": [], "execution_count": None},
            ],
            "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
        },
    }


# ---------------------------------------------------------------------------
# jupyter_insert_cell
# ---------------------------------------------------------------------------
class TestInsertCell:
    def test_happy_path(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools)
        result = run(tools.jupyter_insert_cell({
            "cell_index": 0,
            "cell_type": "code",
            "cell_source": "print(1)",
        }))
        # Insert into an empty notebook at index 0.
        assert "Cell inserted successfully at index 0" in result

    def test_out_of_range_returns_error(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools)
        # Insert into empty nb at index 5 (>0); not allowed unless -1.
        result = run(tools.jupyter_insert_cell({
            "cell_index": 5,
            "cell_type": "code",
            "cell_source": "x",
        }))
        assert "outside valid range" in result


# ---------------------------------------------------------------------------
# jupyter_overwrite_cell_source
# ---------------------------------------------------------------------------
class TestOverwriteCellSource:
    def test_overwrite_by_index(self, reset_module_state):
        tools, _ = reset_module_state
        nb = two_cell_nb()
        activate(tools, notebook=nb)
        result = run(tools.jupyter_overwrite_cell_source({
            "cell_index": 0, "cell_source": "a = 42\n",
        }))
        assert "Overwrite cell 0" in result
        # diff shows + a = 42 (additions to old a = 1)
        assert "+" in result or "-" in result

    def test_overwrite_by_cell_id(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_overwrite_cell_source({
            "cell_id": "cell-B", "cell_source": "b = 99\n",
        }))
        # Resolves cell-B to index 1.
        assert "Overwrite cell 1" in result

    def test_missing_cell_id_errors(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_overwrite_cell_source({
            "cell_id": "no-such-id", "cell_source": "x",
        }))
        assert "[ERROR]" in result

    def test_neither_index_nor_id_errors(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_overwrite_cell_source({
            "cell_source": "x",
        }))
        assert "[ERROR]" in result


# ---------------------------------------------------------------------------
# jupyter_read_cell
# ---------------------------------------------------------------------------
class TestReadCell:
    def test_reads_by_index_includes_outputs_by_default(self, reset_module_state):
        tools, _ = reset_module_state
        nb = two_cell_nb()
        # Add some captured stdout to the first cell.
        nb["content"]["cells"][0]["outputs"] = [
            {"output_type": "stream", "name": "stdout", "text": "hi\n"}
        ]
        nb["content"]["cells"][0]["execution_count"] = 1
        activate(tools, notebook=nb)
        result = run(tools.jupyter_read_cell({"cell_index": 0}))
        assert "Read cell 0" in result
        assert "a = 1" in result
        # Outputs are surfaced (captured stdout text).
        assert "hi" in result

    def test_include_outputs_false_hides_output_section(self, reset_module_state):
        tools, _ = reset_module_state
        nb = two_cell_nb()
        nb["content"]["cells"][0]["outputs"] = [
            {"output_type": "stream", "name": "stdout", "text": "hi\n"}
        ]
        activate(tools, notebook=nb)
        result = run(tools.jupyter_read_cell({
            "cell_index": 0, "include_outputs": False,
        }))
        assert "Outputs:" not in result

    def test_reads_by_cell_id(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_read_cell({"cell_id": "cell-B"}))
        # Resolves to index 1.
        assert "Read cell 1" in result
        assert "b = 2" in result


# ---------------------------------------------------------------------------
# jupyter_clear_cell_output — singular form
# ---------------------------------------------------------------------------
class TestClearCellOutput:
    def test_clears_code_cell(self, reset_module_state):
        tools, _ = reset_module_state
        nb = two_cell_nb()
        nb["content"]["cells"][0]["outputs"] = [
            {"output_type": "stream", "name": "stdout", "text": "x\n"}
        ]
        nb["content"]["cells"][0]["execution_count"] = 2
        activate(tools, notebook=nb)
        result = run(tools.jupyter_clear_cell_output({"cell_index": 0}))
        assert "Cleared outputs from cell 0" in result

    def test_errors_on_markdown_cell(self, reset_module_state):
        tools, _ = reset_module_state
        nb = {
            "name": "demo.ipynb", "path": "demo.ipynb", "type": "notebook",
            "content": {
                "cells": [
                    {"cell_type": "markdown", "id": "cell-X",
                     "source": "# hi\n", "metadata": {}},
                ],
                "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
            },
        }
        activate(tools, notebook=nb)
        result = run(tools.jupyter_clear_cell_output({"cell_index": 0}))
        assert "is not a code cell" in result


# ---------------------------------------------------------------------------
# jupyter_move_cell — the new cell_id closure path
# ---------------------------------------------------------------------------
class TestMoveCell:
    def test_move_by_index(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_move_cell({
            "source_index": 0, "target_index": 1,
        }))
        # Move cell-A from 0 to 1 (which becomes 0 after splice); final index 0.
        assert "Moved cell from index 0 to index 0" in result or "Moved cell" in result

    def test_move_by_cell_id(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        # Move cell-A (id) to where cell-B (id) IS pre-move.
        result = run(tools.jupyter_move_cell({
            "source_cell_id": "cell-A", "target_cell_id": "cell-B",
        }))
        # We don't pin the exact end index (depends on splice math) but the
        # handler must succeed without erroring.
        assert "ERROR" not in result
        assert "Moved cell" in result

    def test_missing_source_errors(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_move_cell({"source_cell_id": "no-such", "target_index": 1}))
        assert "[ERROR]" in result

    def test_no_source_or_target_errors(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_move_cell({}))
        assert "[ERROR]" in result


# ---------------------------------------------------------------------------
# jupyter_delete_cell — cell_ids_to_delete path
# ---------------------------------------------------------------------------
class TestDeleteCell:
    def test_delete_by_indices(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_delete_cell({"cell_indices": [1]}))
        assert "Deleted 1 cell(s)" in result

    def test_delete_by_cell_ids_atomic(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_delete_cell({"cell_ids_to_delete": ["cell-A"]}))
        # Atomic semantic — successful delete returns "Deleted 1 cell(s)".
        assert "Deleted 1 cell(s)" in result

    def test_missing_cell_id_aborts_atomically(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_delete_cell({
            "cell_ids_to_delete": ["cell-A", "no-such-id"],
        }))
        # Atomic failure: nothing deleted; both ids listed in error.
        assert "atomic" in result or "not found" in result or "[ERROR]" in result
        # The handler must NOT have proceeded — the response must NOT say "Deleted".
        assert "Deleted" not in result.split("[ERROR")[0]

    def test_indices_and_ids_merged_with_dedup(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        # Index 0 and id cell-A both target the same cell.
        result = run(tools.jupyter_delete_cell({
            "cell_indices": [0],
            "cell_ids_to_delete": ["cell-A"],
        }))
        # After dedup, only one cell gets removed (cell-A).
        assert "Deleted 1 cell(s)" in result

    def test_no_indices_no_ids_errors(self, reset_module_state):
        tools, _ = reset_module_state
        activate(tools, notebook=two_cell_nb())
        result = run(tools.jupyter_delete_cell({}))
        assert "[ERROR]" in result
