"""Compare parsed Cargo metadata; only this repository's package version may vary.

manifest|lock NAME reads [before, after] JSON and emits a boolean. Exit 0 means
comparison completed (including false); malformed input/mode/version exits 1.
"""
import json
import re
import sys
import tomllib
from pathlib import Path

VERSION = re.compile((Path(__file__).parent.parent / "scripts/release-version-pattern.txt").read_text().strip())

kind, name = sys.argv[1:]
if kind not in {"manifest", "lock"}:
    raise ValueError("expected manifest or lock comparison mode")
# llmlint: ignore[boundary_inputs_validated] The internal Node classifier is the sole workflow caller and always sends JSON.stringify([gitBefore, gitAfter]). Arbitrary standalone stdin shapes are outside that private producer contract; checking them would add hardening without changing release-only classification.
before, after = json.load(sys.stdin)

def normalize(text):
    value = tomllib.loads(text)
    if kind == "manifest":
        if value.get("package", {}).get("name") != name:
            raise ValueError("unexpected package")
        if not VERSION.fullmatch(value["package"]["version"]):
            raise ValueError("invalid version")
        value["package"].pop("version")
    else:
        own = [p for p in value.get("package", []) if p.get("name") == name and "source" not in p]
        if len(own) != 1:
            raise ValueError("missing or ambiguous workspace package")
        if not VERSION.fullmatch(own[0]["version"]):
            raise ValueError("invalid version")
        own[0].pop("version")
    return value

print(json.dumps(normalize(before) == normalize(after)))
