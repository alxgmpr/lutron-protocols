# HTTP SQL API for Designer LocalDB
# Listens on http://+:9999/ and executes SQL queries via sqlcmd
# Auto-discovers LocalDB pipe and project database on each request
#
# Install as scheduled task:
#   $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File C:\tools\sql-http-api.ps1"
#   $trigger = New-ScheduledTaskTrigger -AtLogOn
#   Register-ScheduledTask -TaskName "SQL HTTP API" -Action $action -Trigger $trigger -RunLevel Highest
#
# Usage from macOS:
#   curl -s http://10.0.0.4:9999/query -d "SELECT TOP 5 * FROM tblDevice"
#   curl -s http://10.0.0.4:9999/query-modelinfo -d "SELECT * FROM LSTLINKTYPE"
#   curl -s http://10.0.0.4:9999/databases

$ErrorActionPreference = "Continue"
$port = 9999

function Find-LocalDBPipe {
    $pipes = Get-ChildItem "\\.\pipe\" | Select-Object -ExpandProperty Name | Where-Object { $_ -like "*LOCALDB*" }
    foreach ($pipe in $pipes) {
        if ($pipe -match "\\tsql\\query$") {
            $server = "np:\\.\pipe\$pipe"
        } else {
            $server = "np:\\.\pipe\$pipe\tsql\query"
        }
        & sqlcmd -S $server -E -No -d master -Q "SET NOCOUNT ON; SELECT 1;" -h -1 -W 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return $server }
    }
    return $null
}

function Find-ProjectDB($server) {
    $sql = "SET NOCOUNT ON; SELECT TOP 1 name FROM sys.databases WHERE name = 'Project' OR name LIKE 'Project[_]%' ORDER BY CASE WHEN name = 'Project' THEN 0 ELSE 1 END, create_date DESC;"
    $db = (& sqlcmd -S $server -E -No -d master -Q $sql -h -1 -W 2>$null | Select-Object -First 1)
    if ($db) { return $db.Trim() }
    return $null
}

function Find-ModelInfoDB($server) {
    $sql = "SET NOCOUNT ON; SELECT TOP 1 name FROM sys.databases WHERE name LIKE '%SQLMODELINFO%' ORDER BY create_date DESC;"
    $db = (& sqlcmd -S $server -E -No -d master -Q $sql -h -1 -W 2>$null | Select-Object -First 1)
    if ($db) { return $db.Trim() }
    return $null
}

function Run-Query($server, $database, $sql) {
    $tempFile = [System.IO.Path]::GetTempFileName() + ".sql"
    $sql | Set-Content -Path $tempFile -Encoding UTF8
    try {
        $result = & sqlcmd -S $server -E -No -d $database -b -W -s "|" -i $tempFile 2>&1
        $exitCode = $LASTEXITCODE
        return @{ Output = ($result -join "`n"); ExitCode = $exitCode }
    } finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
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
        $server = Find-LocalDBPipe
        if (-not $server) {
            $output = "ERROR: No LocalDB pipe found"
            $response.StatusCode = 503
        }
        elseif ($path -eq "/databases") {
            $r = Run-Query $server "master" "SET NOCOUNT ON; SELECT name, state_desc, create_date FROM sys.databases ORDER BY name;"
            $output = $r.Output
            if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
        }
        elseif ($path -eq "/query") {
            $db = Find-ProjectDB $server
            if (-not $db) {
                $output = "ERROR: No project database found"
                $response.StatusCode = 404
            } else {
                $r = Run-Query $server $db $body
                $output = $r.Output
                if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
            }
        }
        elseif ($path -eq "/query-master") {
            $r = Run-Query $server "master" $body
            $output = $r.Output
            if ($r.ExitCode -ne 0) { $response.StatusCode = 500 }
        }
        elseif ($path -eq "/query-modelinfo") {
            $db = Find-ModelInfoDB $server
            if (-not $db) {
                $output = "ERROR: No SQLMODELINFO database found"
                $response.StatusCode = 404
            } else {
                $r = Run-Query $server $db $body
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
