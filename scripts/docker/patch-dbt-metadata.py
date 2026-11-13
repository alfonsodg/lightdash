#!/usr/bin/env python3
"""Relax upper-bound version pins on security-patched packages in dbt venvs."""
import glob
import os
import sys
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet

PATCHED_PACKAGES = {
    "werkzeug",
    "redshift-connector",
    "boto3",
    "botocore",
    "s3transfer",
    "deepdiff",
    "cryptography",
    "filelock",
    "jaraco.context",
    "jaraco-context",
    "oauthlib",
    "protobuf",
    "pyopenssl",
    "sqlparse",
    "thrift",
    "urllib3",
    "wheel",
    "cffi",
    "certifi",
}


def relax_requires_dist(line: str) -> str:
    if not line.startswith("Requires-Dist:"):
        return line
    raw_req = line[len("Requires-Dist:") :].strip()
    try:
        req = Requirement(raw_req)
    except Exception:
        return line
    if req.name.lower().replace("_", "-") not in PATCHED_PACKAGES:
        return line
    kept = []
    for spec in req.specifier:
        if spec.operator in ("<", "<="):
            continue
        if spec.operator in ("~=", "=="):
            kept.append(f">={spec.version}")
        else:
            kept.append(str(spec))
    req.specifier = SpecifierSet(",".join(kept))
    return f"Requires-Dist: {req}\n"


def main() -> None:
    site_packages = sys.argv[1]
    for meta in glob.glob(os.path.join(site_packages, "*.dist-info", "METADATA")):
        with open(meta, "r", encoding="utf-8") as f:
            lines = f.readlines()
        updated = [relax_requires_dist(line) for line in lines]
        if updated != lines:
            with open(meta, "w", encoding="utf-8") as f:
                f.writelines(updated)


if __name__ == "__main__":
    main()
