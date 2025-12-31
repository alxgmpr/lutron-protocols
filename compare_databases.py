#!/usr/bin/env python3
"""
Lutron Database Comparison Tool
Dumps schema and data from .mdf files for offline comparison.
Requires Docker with SQL Server 2022 RTM.
"""

import subprocess
import json
import os
import sys
import time

DOCKER_CONTAINER = "sql2022rtm"
SA_PASSWORD = "LutronPass123"

def run_sql(query, database="master"):
    """Run SQL query in Docker container"""
    cmd = [
        "docker", "exec", DOCKER_CONTAINER,
        "/opt/mssql-tools/bin/sqlcmd",
        "-S", "localhost",
        "-U", "sa",
        "-P", SA_PASSWORD,
        "-d", database,
        "-Q", query,
        "-s", "|",
        "-W",
        "-h", "-1"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout.strip()

def attach_database(mdf_path, db_name):
    """Attach a database from .mdf file"""
    # Path inside container
    container_path = mdf_path.replace(os.getcwd(), "/data")

    query = f"""
    CREATE DATABASE [{db_name}] ON
      (FILENAME = '{container_path}')
      FOR ATTACH_FORCE_REBUILD_LOG;
    """
    result = run_sql(query)
    print(f"Attached {db_name}: {result[:100] if result else 'OK'}")
    return True

def detach_database(db_name):
    """Detach a database"""
    query = f"""
    USE master;
    ALTER DATABASE [{db_name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    EXEC sp_detach_db '{db_name}', 'true';
    """
    run_sql(query)
    print(f"Detached {db_name}")

def get_tables(db_name):
    """Get list of all tables"""
    query = """
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
    """
    result = run_sql(query, db_name)
    return [line.strip() for line in result.split('\n') if line.strip()]

def get_table_schema(db_name, table_name):
    """Get column definitions for a table"""
    query = f"""
    SELECT
        COLUMN_NAME,
        DATA_TYPE,
        CHARACTER_MAXIMUM_LENGTH,
        IS_NULLABLE,
        COLUMN_DEFAULT
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = '{table_name}'
    ORDER BY ORDINAL_POSITION
    """
    result = run_sql(query, db_name)
    columns = []
    for line in result.split('\n'):
        if line.strip() and '|' in line:
            parts = [p.strip() for p in line.split('|')]
            if len(parts) >= 4:
                columns.append({
                    'name': parts[0],
                    'type': parts[1],
                    'max_length': parts[2] if parts[2] != 'NULL' else None,
                    'nullable': parts[3],
                    'default': parts[4] if len(parts) > 4 else None
                })
    return columns

def get_row_count(db_name, table_name):
    """Get row count for a table"""
    query = f"SELECT COUNT(*) FROM [{table_name}]"
    result = run_sql(query, db_name)
    try:
        return int(result.strip().split('\n')[0])
    except:
        return 0

def dump_table_data(db_name, table_name, limit=100):
    """Dump sample data from a table"""
    query = f"SELECT TOP {limit} * FROM [{table_name}]"
    return run_sql(query, db_name)

def analyze_database(mdf_path, db_name, output_dir):
    """Full analysis of a database"""
    os.makedirs(output_dir, exist_ok=True)

    print(f"\n{'='*60}")
    print(f"Analyzing: {db_name}")
    print(f"{'='*60}")

    # Attach
    attach_database(mdf_path, db_name)
    time.sleep(2)

    try:
        # Get tables
        tables = get_tables(db_name)
        print(f"Found {len(tables)} tables")

        analysis = {
            'database': db_name,
            'mdf_path': mdf_path,
            'table_count': len(tables),
            'tables': {}
        }

        for table in tables:
            print(f"  Analyzing {table}...")
            schema = get_table_schema(db_name, table)
            row_count = get_row_count(db_name, table)

            analysis['tables'][table] = {
                'row_count': row_count,
                'columns': schema
            }

            # Dump sample data for non-empty tables
            if row_count > 0:
                data = dump_table_data(db_name, table, 50)
                with open(f"{output_dir}/{table}.txt", 'w') as f:
                    f.write(data)

        # Save analysis
        with open(f"{output_dir}/_schema.json", 'w') as f:
            json.dump(analysis, f, indent=2)

        # Save table list
        with open(f"{output_dir}/_tables.txt", 'w') as f:
            for table in tables:
                info = analysis['tables'][table]
                f.write(f"{table}: {info['row_count']} rows, {len(info['columns'])} columns\n")

        print(f"\nAnalysis saved to {output_dir}/")

    finally:
        detach_database(db_name)
        # Clean up log file
        log_file = mdf_path.replace('.mdf', '_log.ldf')
        if os.path.exists(log_file):
            os.remove(log_file)

def compare_schemas(dir1, dir2, output_file):
    """Compare two database schemas"""
    with open(f"{dir1}/_schema.json") as f:
        schema1 = json.load(f)
    with open(f"{dir2}/_schema.json") as f:
        schema2 = json.load(f)

    tables1 = set(schema1['tables'].keys())
    tables2 = set(schema2['tables'].keys())

    report = []
    report.append("# Database Schema Comparison\n")
    report.append(f"DB1: {schema1['database']} ({len(tables1)} tables)")
    report.append(f"DB2: {schema2['database']} ({len(tables2)} tables)\n")

    # Tables only in DB1
    only1 = tables1 - tables2
    if only1:
        report.append(f"\n## Tables only in {schema1['database']}:")
        for t in sorted(only1):
            report.append(f"  - {t}")

    # Tables only in DB2
    only2 = tables2 - tables1
    if only2:
        report.append(f"\n## Tables only in {schema2['database']}:")
        for t in sorted(only2):
            report.append(f"  - {t}")

    # Common tables with differences
    common = tables1 & tables2
    report.append(f"\n## Common tables ({len(common)}):\n")

    for table in sorted(common):
        cols1 = {c['name']: c for c in schema1['tables'][table]['columns']}
        cols2 = {c['name']: c for c in schema2['tables'][table]['columns']}

        col_names1 = set(cols1.keys())
        col_names2 = set(cols2.keys())

        rows1 = schema1['tables'][table]['row_count']
        rows2 = schema2['tables'][table]['row_count']

        if col_names1 != col_names2 or rows1 != rows2:
            report.append(f"### {table}")
            report.append(f"  Rows: {rows1} vs {rows2}")

            only_in_1 = col_names1 - col_names2
            only_in_2 = col_names2 - col_names1

            if only_in_1:
                report.append(f"  Columns only in DB1: {only_in_1}")
            if only_in_2:
                report.append(f"  Columns only in DB2: {only_in_2}")
            report.append("")

    with open(output_file, 'w') as f:
        f.write('\n'.join(report))

    print(f"\nComparison saved to {output_file}")

def main():
    if len(sys.argv) < 2:
        print("""
Lutron Database Comparison Tool

Usage:
  # Analyze a single database
  python3 compare_databases.py analyze <mdf_path> <db_name> <output_dir>

  # Compare two analyzed databases
  python3 compare_databases.py compare <dir1> <dir2> <output_file>

  # Full workflow: analyze and compare two databases
  python3 compare_databases.py full <ra3_mdf> <hw_mdf>

Examples:
  python3 compare_databases.py analyze ra3_extract/db/Project.mdf RA3 ra3_analysis/
  python3 compare_databases.py analyze hw_extract/db/Project.mdf HW hw_analysis/
  python3 compare_databases.py compare ra3_analysis/ hw_analysis/ comparison.md

  # Or all at once:
  python3 compare_databases.py full ra3_extract/db/Project.mdf hw_extract/db/Project.mdf
        """)
        sys.exit(1)

    command = sys.argv[1]

    if command == "analyze":
        if len(sys.argv) != 5:
            print("Usage: analyze <mdf_path> <db_name> <output_dir>")
            sys.exit(1)
        analyze_database(sys.argv[2], sys.argv[3], sys.argv[4])

    elif command == "compare":
        if len(sys.argv) != 5:
            print("Usage: compare <dir1> <dir2> <output_file>")
            sys.exit(1)
        compare_schemas(sys.argv[2], sys.argv[3], sys.argv[4])

    elif command == "full":
        if len(sys.argv) != 4:
            print("Usage: full <ra3_mdf> <hw_mdf>")
            sys.exit(1)

        ra3_mdf = sys.argv[2]
        hw_mdf = sys.argv[3]

        analyze_database(ra3_mdf, "RA3", "ra3_analysis")
        analyze_database(hw_mdf, "HW", "hw_analysis")
        compare_schemas("ra3_analysis", "hw_analysis", "schema_comparison.md")

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)

if __name__ == '__main__':
    main()
