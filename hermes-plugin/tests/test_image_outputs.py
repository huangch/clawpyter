"""Tests for the image-aware output rendering path.

`_format_iopub_for_agent` is the per-message helper; `_outputs_to_cell_outputs`
is the round-trip back into the cell's `outputs` list so a JupyterLab viewer
re-renders the image after the agent finishes.

Both are pure functions, so the suite runs without any kernel/WebSocket setup.
"""

from __future__ import annotations

from hermes_plugin.tests._bootstrap import install_plugin_package

install_plugin_package()

import hermes_plugin.tools as tools


# ---------------------------------------------------------------------------
# iopub → agent chunk (text)
# ---------------------------------------------------------------------------

class TestStreamChunk:
    def test_stdout_text_emits_stout_wrapped_chunk(self):
        chunks = tools._format_iopub_for_agent(
            "stream", {"text": "hello\n", "name": "stdout"},
        )
        assert chunks == ["[STDOUT]\nhello\n\n[/STDOUT]"]

    def test_stderr_text_emits_stderr_wrapped_chunk(self):
        chunks = tools._format_iopub_for_agent(
            "stream", {"text": "boom\n", "name": "stderr"},
        )
        assert chunks == ["[STDERR]\nboom\n\n[/STDERR]"]

    def test_empty_text_emits_no_chunk(self):
        chunks = tools._format_iopub_for_agent(
            "stream", {"text": "", "name": "stdout"},
        )
        assert chunks == []


class TestErrorChunk:
    def test_error_emits_bracket_error(self):
        chunks = tools._format_iopub_for_agent(
            "error", {"ename": "ZeroDivisionError", "evalue": "div by zero"},
        )
        assert chunks == ["[ERROR: ZeroDivisionError: div by zero]"]


# ---------------------------------------------------------------------------
# iopub → agent chunk (image + text)
# ---------------------------------------------------------------------------

class TestImageAwareness:
    def test_image_png_with_text_emits_image_then_result(self):
        chunks = tools._format_iopub_for_agent(
            "execute_result", {
                "execution_count": 7,
                "data": {
                    "text/plain": "<Figure size 800x600 with 1 Axes>",
                    "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA=",
                },
            },
        )
        assert len(chunks) == 2
        # First chunk carries the image, embedded as a markdown data URI.
        img, text = chunks
        assert img.startswith("[IMAGE: image/png]")
        assert img.endswith("[/IMAGE]")
        assert "![output](data:image/png;base64," in img
        assert "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA=" in img
        # Second chunk is the text/plain render (RESULT tag for execute_result).
        assert text.startswith("[RESULT]")
        assert "<Figure size 800x600 with 1 Axes>" in text

    def test_image_only_display_data_has_no_text_chunk(self):
        chunks = tools._format_iopub_for_agent(
            "display_data", {"data": {"image/png": "AAAA"}},
        )
        assert len(chunks) == 1
        assert chunks[0].startswith("[IMAGE: image/png]")
        assert "AAAA" in chunks[0]

    def test_svg_image_uses_utf8_data_url(self):
        chunks = tools._format_iopub_for_agent(
            "display_data", {
                "data": {"image/svg+xml": "<svg>hi</svg>"},
            },
        )
        assert len(chunks) == 1
        assert "data:image/svg+xml;utf8,<svg>hi</svg>" in chunks[0]

    def test_prefers_svg_over_png_over_jpeg(self):
        chunks = tools._format_iopub_for_agent(
            "display_data", {
                "data": {
                    "image/png": "png-payload",
                    "image/jpeg": "jpeg-payload",
                    "image/svg+xml": "<svg/>",
                },
            },
        )
        # Only one image chunk (best MIME wins).
        assert len(chunks) == 1
        assert "image/svg+xml" in chunks[0]

    def test_text_only_emit_renders_plain_text(self):
        chunks = tools._format_iopub_for_agent(
            "execute_result", {
                "execution_count": 1,
                "data": {"text/plain": "42"},
            },
        )
        assert chunks == ["[RESULT]\n42\n[/RESULT]"]

    def test_oversize_image_budget_marks_truncated(self, monkeypatch):
        # Override the budget to 16 bytes so we can exercise the truncation
        # path without crafting megabytes of base64 in a unit test.
        monkeypatch.setattr(tools, "_MAX_IMAGE_BYTES", 16)
        chunks = tools._format_iopub_for_agent(
            "display_data", {
                "data": {"image/png": "A" * 64},
            },
        )
        assert len(chunks) == 1
        assert "truncated" in chunks[0]
        assert "image/png" in chunks[0]


# ---------------------------------------------------------------------------
# Round-trip back into a cell-output list
# ---------------------------------------------------------------------------

class TestOutputsToCellOutputs:
    def test_stream_chunk_becomes_output_type_stream(self):
        nb = tools._outputs_to_cell_outputs([
            "[STDOUT]\nhello\n\n[/STDOUT]",
            "[STDERR]\nboom\n\n[/STDERR]",
        ])
        assert nb == [
            {"output_type": "stream", "name": "stdout", "text": "hello"},
            {"output_type": "stream", "name": "stderr", "text": "boom"},
        ]

    def test_image_chunk_becomes_display_data_with_bare_base64(self):
        nb = tools._outputs_to_cell_outputs([
            "[IMAGE: image/png]\n"
            "![output](data:image/png;base64,iVBORw0K)\n"
            "[/IMAGE]"
        ])
        assert nb == [
            {
                "output_type": "display_data",
                "data": {"image/png": "iVBORw0K"},
                "metadata": {},
            }
        ]

    def test_svg_chunk_becomes_display_data_with_bare_svg(self):
        nb = tools._outputs_to_cell_outputs([
            "[IMAGE: image/svg+xml]\n"
            "![output](data:image/svg+xml;utf8,<svg/>)\n"
            "[/IMAGE]"
        ])
        assert nb == [
            {
                "output_type": "display_data",
                "data": {"image/svg+xml": "<svg/>"},
                "metadata": {},
            }
        ]

    def test_text_chunk_becomes_display_data_text_plain(self):
        nb = tools._outputs_to_cell_outputs(["[RESULT]\n42\n[/RESULT]"])
        assert nb == [
            {
                "output_type": "display_data",
                "data": {"text/plain": "42"},
                "metadata": {},
            }
        ]

    def test_round_trip_execute_result_with_image_and_text(self):
        # Most production case: matplotlib prints "<Figure ...>" AND emits
        # image/png. Both must survive the round-trip into the cell.
        chunks = tools._format_iopub_for_agent(
            "execute_result", {
                "execution_count": 9,
                "data": {
                    "image/png": "png-bytes",
                    "text/plain": "<Figure>",
                },
            },
        )
        nb = tools._outputs_to_cell_outputs(chunks)
        assert len(nb) == 2
        assert nb[0] == {
            "output_type": "display_data",
            "data": {"image/png": "png-bytes"},
            "metadata": {},
        }
        assert nb[1] == {
            "output_type": "display_data",
            "data": {"text/plain": "<Figure>"},
            "metadata": {},
        }

    def test_unknown_chunk_falls_back_to_stdout_stream(self):
        nb = tools._outputs_to_cell_outputs(["just a raw line"])
        assert nb == [
            {"output_type": "stream", "name": "stdout", "text": "just a raw line"},
        ]
