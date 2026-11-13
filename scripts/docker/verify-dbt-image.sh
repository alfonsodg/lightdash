#!/bin/sh
set -eu

verify() {
    version="$1"
    shift
    python="/usr/local/dbt${version}/bin/python"
    entrypoint="/usr/local/bin/dbt${version}"

    test -x "$python"
    test -x "$entrypoint"
    "$entrypoint" --version >/dev/null
    "$python" -m pip check
    "$python" - "$@" <<'PY'
import importlib.util
import sys

missing = [
    adapter
    for adapter in sys.argv[1:]
    if importlib.util.find_spec(f'dbt.adapters.{adapter}') is None
]
if missing:
    raise SystemExit(f'Missing dbt adapters: {", ".join(missing)}')
PY
}

verify 1.4 bigquery postgres redshift snowflake databricks trino clickhouse
verify 1.5 bigquery postgres redshift snowflake databricks trino clickhouse
verify 1.6 bigquery postgres redshift snowflake databricks trino clickhouse
verify 1.7 bigquery postgres redshift snowflake databricks trino clickhouse
verify 1.8 bigquery postgres redshift snowflake databricks trino clickhouse duckdb
verify 1.9 bigquery postgres redshift snowflake databricks trino clickhouse athena duckdb
verify 1.10 bigquery postgres redshift snowflake databricks trino clickhouse athena duckdb
verify 1.11 bigquery postgres redshift snowflake databricks trino clickhouse athena duckdb
verify 1.12 bigquery postgres redshift snowflake databricks trino clickhouse athena duckdb
