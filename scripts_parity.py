"""Clawpyter parity sweep v3."""
import re
from pathlib import Path


def names_in_ts(p):
    s = p.read_text()
    return sorted(
        set(re.findall(r'api\.registerTool\(\s*\{\s*\n\s*name:\s*"(jupyter_[a-z_]+)"', s))
    )


def names_in_hermes_handlers(p):
    src = p.read_text()
    return sorted(set(re.findall(r'async def (jupyter_[a-z_]+)\(', src)))


def names_in_hermes_schemas(p):
    src = p.read_text()
    const_names = sorted(set(re.findall(r'^JUPYTER_([A-Z_][A-Z_0-9]*)\s*=', src, re.M)))
    # Map JUPYTER_FOO_BAR → jupyter_foo_bar
    return sorted("jupyter_" + n.lower() for n in const_names)


def names_in_hermes_yaml(p):
    if not p.exists():
        return []
    txt = p.read_text()
    return sorted(set(re.findall(r'^\s*-\s+(jupyter_[a-z_]+)\s*$', txt, re.M)))


def fields_in_ts_tool(toolname, src):
    pattern = (
        r'name:\s*"' + re.escape(toolname) + r'".*?parameters:\s*Type\.Object\(\{'
        r'(.*?)^\s*\}\)'
    )
    m = re.search(pattern, src, re.S | re.M)
    if not m:
        return None
    body = m.group(1)
    return re.findall(r'\b([a-z_][a-z_0-9]*)\s*:\s*Type', body)


def fields_in_hermes_schema(toolname, src):
    const = "JUPYTER_" + toolname.upper().removeprefix("JUPYTER_")
    m = re.search(rf'^{re.escape(const)}\s*=\s*\{{(.*?)^}}', src, re.S | re.M)
    if not m:
        return None
    body = m.group(1)
    out = []
    in_props = False
    depth = 0
    for line in body.split("\n"):
        if not in_props:
            idx = line.find('"properties":')
            if idx >= 0 and "{" in line[idx:]:
                in_props = True
                for ch in line[idx:]:
                    if ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                continue
            continue
        for ch in line:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
        if depth <= 0:
            break
        m2 = re.match(r'\s*"([a-z_][a-z_0-9]*)":', line)
        if m2:
            out.append(m2.group(1))
    return out


base = Path("/workspace/wsinsight/clawpyter")
ts_idx = base / "openclaw-plugin/src/index.ts"
hermes_tools = base / "hermes-plugin/tools.py"
hermes_schemas = base / "hermes-plugin/schemas.py"
hermes_yaml = base / "hermes-plugin/plugin.yaml"

ts_set = set(names_in_ts(ts_idx))
hermes_tools_set = set(names_in_hermes_handlers(hermes_tools))
hermes_schema_set = set(names_in_hermes_schemas(hermes_schemas))
hermes_yaml_set = set(names_in_hermes_yaml(hermes_yaml))

print("== Per-runtime tool counts ==")
print(f"OpenClaw TS registerTool: {len(ts_set)}")
print(f"Hermes handlers        : {len(hermes_tools_set)}")
print(f"Hermes schemas         : {len(hermes_schema_set)}")
print(f"Hermes plugin.yaml     : {len(hermes_yaml_set)}")
print()
print("== Cross-runtime parity ==")
extra_ts = ts_set - hermes_tools_set
extra_h = hermes_tools_set - ts_set
print("In TS but not Hermes:", sorted(extra_ts) if extra_ts else "(none)")
print("In Hermes but not TS:", sorted(extra_h) if extra_h else "(none)")
print()
print("== Hermes internal parity ==")
print("Handlers missing schema:", sorted(hermes_tools_set - hermes_schema_set) or "(none)")
print("Schemas missing handler:", sorted(hermes_schema_set - hermes_tools_set) or "(none)")
print("Handlers missing plugin.yaml:", sorted(hermes_tools_set - hermes_yaml_set) or "(none)")

intersection = ts_set & hermes_tools_set & hermes_schema_set & hermes_yaml_set
print(f"\n4-way intersection: {len(intersection)} tools")
print()

print("== TS schema fields per patched tool ==")
ts_src = ts_idx.read_text()
for tool in [
    "jupyter_overwrite_cell_source",
    "jupyter_read_cell",
    "jupyter_edit_cell_source",
    "jupyter_execute_cell",
    "jupyter_execute_code",
]:
    print(f"  {tool:38s} {fields_in_ts_tool(tool, ts_src)}")

print()
print("== Hermes schema fields per patched tool ==")
hs_src = hermes_schemas.read_text()
for tool in [
    "jupyter_overwrite_cell_source",
    "jupyter_read_cell",
    "jupyter_edit_cell_source",
    "jupyter_execute_cell",
    "jupyter_execute_code",
]:
    print(f"  {tool:38s} {fields_in_hermes_schema(tool, hs_src)}")
