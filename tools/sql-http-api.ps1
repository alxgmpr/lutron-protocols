# HTTP SQL API for Designer LocalDB
# Listens on http://+:9999/ and executes SQL queries via .NET SqlClient
# Auto-discovers LocalDB pipe and project database on each request
#
# Install as scheduled task:
#   $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File C:\tools\sql-http-api.ps1"
#   $trigger = New-ScheduledTaskTrigger -AtLogOn
#   Register-ScheduledTask -TaskName "SQL HTTP API" -Action $action -Trigger $trigger -RunLevel Highest
#
# Usage from macOS:
#   curl -s http://192.168.64.4:9999/query -d "SELECT TOP 5 * FROM tblDevice"
#   curl -s http://192.168.64.4:9999/query-modelinfo -d "SELECT * FROM LSTLINKTYPE"
#   curl -s http://192.168.64.4:9999/databases

$ErrorActionPreference = "Continue"
$port = 9999

function Find-LocalDBPipe {
    $pipes = Get-ChildItem "\\.\pipe\" | Select-Object -ExpandProperty Name | Where-Object { $_ -like "*LOCALDB*tsql*" }
    foreach ($pipe in $pipes) {
        $connStr = "Server=np:\\.\pipe\$pipe;Integrated Security=true;Database=master;Connect Timeout=5"
        try {
            $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
            $conn.Open()
            $conn.Close()
            return $pipe
        } catch {
            continue
        }
    }
    return $null
}

function Find-DB($pipe, $sql) {
    $connStr = "Server=np:\\.\pipe\$pipe;Integrated Security=true;Database=master;Connect Timeout=10"
    try {
        $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sql
        $cmd.CommandTimeout = 10
        $val = $cmd.ExecuteScalar()
        $conn.Close()
        if ($val) { return $val.ToString().Trim() }
    } catch {
        if ($conn -and $conn.State -eq 'Open') { $conn.Close() }
    }
    return $null
}

function Find-ProjectDB($pipe) {
    return Find-DB $pipe "SELECT TOP 1 name FROM sys.databases WHERE name = 'Project' OR name LIKE 'Project[_]%' ORDER BY CASE WHEN name = 'Project' THEN 0 ELSE 1 END, create_date DESC"
}

function Find-ModelInfoDB($pipe) {
    return Find-DB $pipe "SELECT TOP 1 name FROM sys.databases WHERE name LIKE '%SQLMODELINFO%' ORDER BY create_date DESC"
}

function Run-SqlQuery($pipe, $database, $sql) {
    $connStr = "Server=np:\\.\pipe\$pipe;Integrated Security=true;Database=$database;Connect Timeout=30"
    try {
        $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sql
        $cmd.CommandTimeout = 30
        $reader = $cmd.ExecuteReader()

        $lines = @()
        # Header
        $cols = @()
        for ($i = 0; $i -lt $reader.FieldCount; $i++) {
            $cols += $reader.GetName($i)
        }
        $lines += ($cols -join "|")

        # Rows
        $rowCount = 0
        while ($reader.Read()) {
            $vals = @()
            for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                if ($reader.IsDBNull($i)) { $vals += "NULL" }
                else { $vals += $reader[$i].ToString() }
            }
            $lines += ($vals -join "|")
            $rowCount++
        }
        $reader.Close()

        # Check for rows affected (non-SELECT)
        if ($rowCount -eq 0 -and $cols.Count -eq 0) {
            # Re-run as non-query
            $conn.Close()
            $conn.Open()
            $cmd2 = $conn.CreateCommand()
            $cmd2.CommandText = $sql
            $cmd2.CommandTimeout = 30
            $affected = $cmd2.ExecuteNonQuery()
            $conn.Close()
            return @{ Output = "($affected rows affected)"; ExitCode = 0 }
        }

        $conn.Close()
        $output = $lines -join "`n"
        if ($rowCount -gt 0) { $output += "`n`n($rowCount rows affected)" }
        return @{ Output = $output; ExitCode = 0 }
    } catch {
        if ($conn -and $conn.State -eq 'Open') { $conn.Close() }
        return @{ Output = "ERROR: $_"; ExitCode = 1 }
    }
}

# Start HTTP listener
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$port/")
try {
    $listener.Start()
} catch {
    Write-Host "Failed to start listener on port $port. Run as Administrator or use: netsh http add urlacl url=http://+:$port/ user=Everyone"
    exit 1
}

Write-Host "SQL HTTP API listening on http://+:$port/"
Write-Host "Endpoints: /query (project DB), /query-master (master DB), /query-modelinfo (SQLMODELINFO), /databases"

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        $path = $request.Url.AbsolutePath

        # Read request body
        $reader = New-Object System.IO.StreamReader($request.InputStream)
        $body = $reader.ReadToEnd()
        $reader.Close()

        $response.ContentType = "text/plain; charset=utf-8"
        $output = ""

        # Discover pipe on each request (handles pipe changes)
        $pipe = Find-LocalDBPipe
        if (-not $pipe) {
            $output = "ERROR: No LocalDB pipe found"
            $response.StatusCode = 503
        }
        elseif ($path -eq "/databases") {
            $r = Run-SqlQuery $pipe "master" "SELECT name, state_desc, create_date FROM sys.databases ORDER BY name"
            $output = $r.Output
            if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
        }
        elseif ($path -eq "/query") {
            $db = Find-ProjectDB $pipe
            if (-not $db) {
                $output = "ERROR: No project database found"
                $response.StatusCode = 404
            } else {
                $r = Run-SqlQuery $pipe $db $body
                $output = $r.Output
                if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
            }
        }
        elseif ($path -eq "/query-master") {
            $r = Run-SqlQuery $pipe "master" $body
            $output = $r.Output
            if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
        }
        elseif ($path -eq "/query-modelinfo") {
            $db = Find-ModelInfoDB $pipe
            if (-not $db) {
                $output = "ERROR: No SQLMODELINFO database found"
                $response.StatusCode = 404
            } else {
                $r = Run-SqlQuery $pipe $db $body
                $output = $r.Output
                if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
            }
        }
        else {
            $output = "Endpoints: POST /query, POST /query-master, POST /query-modelinfo, GET /databases"
            $response.StatusCode = 404
        }

        $bytes = [System.Text.Encoding]::UTF8.GetBytes($output)
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
        $response.OutputStream.Close()

        Write-Host "$(Get-Date -Format 'HH:mm:ss') $($request.HttpMethod) $path -> $($response.StatusCode)"
    }
    catch {
        Write-Host "Error: $_"
    }
}
