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

function Get-AllLocalDBPipes {
    $pipes = @()
    $instances = & SqlLocalDB.exe info 2>$null
    foreach ($inst in $instances) {
        $inst = $inst.Trim()
        if (-not $inst) { continue }
        $info = & SqlLocalDB.exe info $inst 2>$null
        $pipeLine = $info | Where-Object { $_ -match "Instance pipe name:\s+(.+)" }
        $pipe = if ($pipeLine -and $Matches[1].Trim()) { $Matches[1].Trim() } else { $null }
        $stateLine = $info | Where-Object { $_ -match "State:\s+(\w+)" }
        $state = if ($stateLine) { $Matches[1] } else { "Unknown" }
        $pipes += [PSCustomObject]@{ Instance = $inst; Pipe = $pipe; State = $state }
    }
    return $pipes
}

function Find-LocalDBServer {
    # Scan actual named pipes — sqllocaldb info is unreliable (reports Stopped while pipes are live)
    $pipes = Get-ChildItem "\\.\pipe\" | Select-Object -ExpandProperty Name | Where-Object { $_ -like "*LOCALDB*tsql*" }
    foreach ($p in $pipes) {
        $server = "np:\\.\pipe\$p"
        $connStr = "Server=$server;Integrated Security=true;Database=master;Connect Timeout=5"
        try {
            $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
            $conn.Open()
            $conn.Close()
            return $server
        } catch {
            continue
        }
    }
    return $null
}

function Resolve-Server($context) {
    $qs = $context.Request.QueryString
    $explicit = $qs["pipe"]
    if ($explicit) { return "np:\\.\pipe\$explicit" }
    return Find-LocalDBServer
}

function Find-DB($server, $sql) {
    $connStr = "Server=$server;Integrated Security=true;Database=master;Connect Timeout=10"
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

function Find-ProjectDB($server) {
    return Find-DB $server "SELECT TOP 1 name FROM sys.databases WHERE name = 'Project' OR name LIKE 'Project[_]%' ORDER BY CASE WHEN name = 'Project' THEN 0 ELSE 1 END, create_date DESC"
}

function Find-ModelInfoDB($server) {
    return Find-DB $server "SELECT TOP 1 name FROM sys.databases WHERE name LIKE '%SQLMODELINFO%' ORDER BY create_date DESC"
}

function Run-SqlQuery($server, $database, $sql) {
    $connStr = "Server=$server;Integrated Security=true;Database=$database;Connect Timeout=30"
    try {
        $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sql
        $cmd.CommandTimeout = 30
        $reader = $cmd.ExecuteReader()

        $lines = @()
        $cols = @()
        for ($i = 0; $i -lt $reader.FieldCount; $i++) {
            $cols += $reader.GetName($i)
        }

        $rowCount = 0
        if ($cols.Count -gt 0) {
            $lines += ($cols -join "|")
            while ($reader.Read()) {
                $vals = @()
                for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                    if ($reader.IsDBNull($i)) { $vals += "NULL" }
                    else { $vals += $reader[$i].ToString() }
                }
                $lines += ($vals -join "|")
                $rowCount++
            }
        }

        # Must read RecordsAffected before closing the reader. -1 = no DML.
        $affected = $reader.RecordsAffected
        $reader.Close()
        $conn.Close()

        if ($cols.Count -eq 0) {
            $count = if ($affected -lt 0) { 0 } else { $affected }
            return @{ Output = "($count rows affected)"; ExitCode = 0 }
        }

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
Write-Host "Endpoints: /query, /query-master, /query-modelinfo, /databases, /pipes"
Write-Host "Always uses MSSQLLocalDB (never Troubleshooting). Override: ?pipe=<name>"

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

        if ($path -eq "/pipes") {
            # /pipes doesn't need a server connection — just list instances
            $allPipes = Get-AllLocalDBPipes
            $lines = @()
            foreach ($p in $allPipes) {
                $isTroubleshooting = $p.Instance -like "*Troubleshooting*"
                $label = if ($isTroubleshooting) { " [Troubleshooting - NEVER use]" } else { "" }
                $pipeStr = if ($p.Pipe) { $p.Pipe } else { "(no pipe - stopped)" }
                $lines += "$($p.Instance) | $($p.State) | $pipeStr$label"
            }
            $output = $lines -join "`n"
        }
        else {
        # All other endpoints need a server connection
        $server = Resolve-Server $context
        if (-not $server) {
            $output = "ERROR: MSSQLLocalDB not running - start Designer first"
            $response.StatusCode = 503
        }
        elseif ($path -eq "/databases") {
            $r = Run-SqlQuery $server "master" "SELECT name, state_desc, create_date FROM sys.databases ORDER BY name"
            $output = $r.Output
            if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
        }
        elseif ($path -eq "/query") {
            $db = Find-ProjectDB $server
            if (-not $db) {
                $output = "ERROR: No project database found"
                $response.StatusCode = 404
            } else {
                $r = Run-SqlQuery $server $db $body
                $output = $r.Output
                if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
            }
        }
        elseif ($path -eq "/query-master") {
            $r = Run-SqlQuery $server "master" $body
            $output = $r.Output
            if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
        }
        elseif ($path -eq "/query-modelinfo") {
            $db = Find-ModelInfoDB $server
            if (-not $db) {
                $output = "ERROR: No SQLMODELINFO database found"
                $response.StatusCode = 404
            } else {
                $r = Run-SqlQuery $server $db $body
                $output = $r.Output
                if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
            }
        }
        else {
            $output = "Endpoints: POST /query, POST /query-master, POST /query-modelinfo, GET /databases, GET /pipes"
            $response.StatusCode = 404
        }
        } # end server-required block

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
