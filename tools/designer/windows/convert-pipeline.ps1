<#
.SYNOPSIS
  Orchestrated RA3 <-> HomeWorks conversion pipeline.

.DESCRIPTION
  Runs preflight checks, conversion, and verification against Designer LocalDB.
  Generates JSON/markdown reports and rollback scripts on failure.

.EXAMPLE
  .\convert-pipeline.ps1 -Direction RA3_TO_HW -Command preflight
  .\convert-pipeline.ps1 -Direction RA3_TO_HW -Command full
  .\convert-pipeline.ps1 -Direction HW_TO_RA3 -Command verify -Json
#>

param(
  [ValidateSet('RA3_TO_HW','HW_TO_RA3')]
  [string]$Direction = 'RA3_TO_HW',

  [ValidateSet('preflight','convert','verify','full')]
  [string]$Command = 'preflight',

  [string]$Database = 'AUTO',

  [string]$SnapshotFile = '',

  [switch]$Json,

  [switch]$NoRollback
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SqlRoot = Join-Path (Split-Path -Parent $ScriptRoot) "sql"

# ============================================================================
# LocalDB discovery (reuses logic from run-localdb.ps1)
# ============================================================================

function Find-ProjectServer {
  $pipes = Get-ChildItem "\\.\pipe\" |
    Select-Object -ExpandProperty Name |
    Where-Object { $_ -like "*LOCALDB*" }

  if (-not $pipes) {
    throw "No LOCALDB pipe found. Is Designer running?"
  }

  foreach ($pipe in $pipes) {
    if ($pipe -match "\\tsql\\query$") {
      $server = "np:\\.\pipe\$pipe"
    } else {
      $server = "np:\\.\pipe\$pipe\tsql\query"
    }
    & sqlcmd -S $server -E -No -d master -Q "SET NOCOUNT ON; SELECT DB_NAME();" -h -1 -W 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) {
      return $server
    }
  }

  throw "Could not connect to any LOCALDB pipe."
}

function Resolve-DatabaseName {
  param(
    [string]$Server,
    [string]$Requested
  )

  if ($Requested -and $Requested -ne "AUTO") {
    return $Requested
  }

  $sql = "SET NOCOUNT ON; SELECT TOP 1 name FROM sys.databases WHERE name = 'Project' OR name LIKE 'Project[_]%' ORDER BY CASE WHEN name = 'Project' THEN 0 ELSE 1 END, create_date DESC;"
  $db = (& sqlcmd -S $Server -E -No -d master -Q $sql -h -1 -W 2>$null | Select-Object -First 1).Trim()
  if (-not $db) {
    throw "No project database found (expected 'Project' or 'Project_%')."
  }
  return $db
}

# ============================================================================
# SQL execution and output parsing
# ============================================================================

function Invoke-PipelineSQL {
  param(
    [string]$SqlFile,
    [string]$Server,
    [string]$Db,
    [string]$Dir
  )

  $sqlContent = Get-Content $SqlFile -Raw

  # Inject @Direction value
  $sqlContent = $sqlContent -replace
    "DECLARE @Direction NVARCHAR\(16\) = N'[^']*'",
    "DECLARE @Direction NVARCHAR(16) = N'$Dir'"

  $tempFile = Join-Path $env:TEMP "lutron-pipeline-$(Get-Random).sql"
  Set-Content -Path $tempFile -Value $sqlContent -Encoding UTF8

  try {
    $output = & sqlcmd -S $Server -E -No -d $Db -b -W -s "|" -i $tempFile 2>&1
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
      $errorLines = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } |
        ForEach-Object { $_.ToString() }) -join "`n"
      if (-not $errorLines) {
        $errorLines = ($output | Out-String).Trim()
      }
      throw "SQL execution failed (exit $exitCode): $errorLines"
    }

    # Filter to string lines only (exclude ErrorRecord objects)
    $textLines = $output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } |
      ForEach-Object { $_.ToString() }
    return $textLines
  } finally {
    Remove-Item $tempFile -ErrorAction SilentlyContinue
  }
}

function Parse-Sections {
  param(
    [string[]]$RawOutput
  )

  $sections = @{}
  $currentSection = $null
  $currentHeaders = $null
  $currentRows = @()

  foreach ($line in $RawOutput) {
    $line = $line.Trim()
    if (-not $line -or $line -match '^-+[\|-]+') {
      continue  # Skip empty lines and separator lines
    }

    $parts = $line -split '\|' | ForEach-Object { $_.Trim() }
    if ($parts.Count -lt 2) { continue }

    # Check if this is a header row (contains _Section as first column name)
    if ($parts[0] -eq '_Section') {
      # Flush previous section
      if ($currentSection -and $currentRows.Count -gt 0) {
        if (-not $sections.ContainsKey($currentSection)) {
          $sections[$currentSection] = @()
        }
        $sections[$currentSection] += $currentRows
        $currentRows = @()
      }
      $currentHeaders = $parts[1..($parts.Count-1)]
      $currentSection = $null
      continue
    }

    # Data row
    if ($currentHeaders) {
      $sectionName = $parts[0]
      $values = $parts[1..($parts.Count-1)]

      # Track section transitions
      if ($sectionName -ne $currentSection) {
        if ($currentSection -and $currentRows.Count -gt 0) {
          if (-not $sections.ContainsKey($currentSection)) {
            $sections[$currentSection] = @()
          }
          $sections[$currentSection] += $currentRows
          $currentRows = @()
        }
        $currentSection = $sectionName
      }

      $row = [ordered]@{}
      for ($i = 0; $i -lt $currentHeaders.Count -and $i -lt $values.Count; $i++) {
        $row[$currentHeaders[$i]] = $values[$i]
      }
      $currentRows += [PSCustomObject]$row
    }
  }

  # Flush final section
  if ($currentSection -and $currentRows.Count -gt 0) {
    if (-not $sections.ContainsKey($currentSection)) {
      $sections[$currentSection] = @()
    }
    $sections[$currentSection] += $currentRows
  }

  return $sections
}

# ============================================================================
# Pipeline phases
# ============================================================================

function Run-Preflight {
  param(
    [string]$Server,
    [string]$Db,
    [string]$Dir
  )

  $sqlFile = Join-Path $SqlRoot "pipeline-preflight.sql"
  if (-not (Test-Path $sqlFile)) {
    throw "Preflight SQL not found: $sqlFile"
  }

  Write-Host "Running preflight ($Dir)..." -ForegroundColor Cyan
  $raw = Invoke-PipelineSQL -SqlFile $sqlFile -Server $Server -Db $Db -Dir $Dir
  $sections = Parse-Sections -RawOutput $raw

  # Save snapshot
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $snapshotPath = Join-Path $env:TEMP "lutron-preflight-$timestamp.json"
  $snapshot = @{
    direction = $Dir
    database = $Db
    timestamp = (Get-Date -Format "o")
    sections = @{}
  }
  foreach ($key in $sections.Keys) {
    $snapshot.sections[$key] = @($sections[$key])
  }
  $snapshot | ConvertTo-Json -Depth 10 | Set-Content -Path $snapshotPath -Encoding UTF8
  Write-Host "Snapshot saved: $snapshotPath" -ForegroundColor DarkGray

  return @{
    sections = $sections
    snapshotFile = $snapshotPath
    raw = $raw
  }
}

function Run-Convert {
  param(
    [string]$Server,
    [string]$Db,
    [string]$Dir
  )

  $sqlFile = Join-Path $SqlRoot "pipeline-convert.sql"
  if (-not (Test-Path $sqlFile)) {
    throw "Convert SQL not found: $sqlFile"
  }

  Write-Host "Running conversion ($Dir)..." -ForegroundColor Yellow
  $raw = Invoke-PipelineSQL -SqlFile $sqlFile -Server $Server -Db $Db -Dir $Dir
  $sections = Parse-Sections -RawOutput $raw

  if ($sections.ContainsKey('CONVERT_ERROR')) {
    $err = $sections['CONVERT_ERROR'][0]
    throw "Conversion failed: $($err.ErrorMessage)"
  }

  return @{
    sections = $sections
    raw = $raw
  }
}

function Run-Verify {
  param(
    [string]$Server,
    [string]$Db,
    [string]$Dir
  )

  $sqlFile = Join-Path $SqlRoot "pipeline-verify.sql"
  if (-not (Test-Path $sqlFile)) {
    throw "Verify SQL not found: $sqlFile"
  }

  Write-Host "Running verification ($Dir)..." -ForegroundColor Cyan
  $raw = Invoke-PipelineSQL -SqlFile $sqlFile -Server $Server -Db $Db -Dir $Dir
  $sections = Parse-Sections -RawOutput $raw

  return @{
    sections = $sections
    raw = $raw
  }
}

# ============================================================================
# Rollback generation
# ============================================================================

function New-RollbackScript {
  param(
    [string]$Dir,
    [string]$Db
  )

  if ($Dir -eq 'RA3_TO_HW') { $reverseDir = 'HW_TO_RA3' } else { $reverseDir = 'RA3_TO_HW' }
  $convertSql = Join-Path $SqlRoot "pipeline-convert.sql"
  $content = Get-Content $convertSql -Raw

  # Inject reverse direction
  $content = $content -replace
    "DECLARE @Direction NVARCHAR\(16\) = N'[^']*'",
    "DECLARE @Direction NVARCHAR(16) = N'$reverseDir'"

  $genTime = Get-Date -Format "o"
  $header = "-- =============================================================================`r`n"
  $header += "-- ROLLBACK SCRIPT (auto-generated by convert-pipeline.ps1)`r`n"
  $header += "-- Original direction: $Dir`r`n"
  $header += "-- Rollback direction: $reverseDir`r`n"
  $header += "-- Database: $Db`r`n"
  $header += "-- Generated: $genTime`r`n"
  $header += "-- =============================================================================`r`n"
  $header += "-- Run this in the project database to reverse the conversion.`r`n"
  $header += "-- =============================================================================`r`n`r`n"

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $rollbackPath = Join-Path $env:TEMP "lutron-rollback-$timestamp.sql"
  Set-Content -Path $rollbackPath -Value ($header + $content) -Encoding UTF8

  return $rollbackPath
}

# ============================================================================
# Output formatting
# ============================================================================

function Write-MarkdownReport {
  param(
    [hashtable]$Report
  )

  Write-Host ""
  Write-Host "# Conversion Pipeline Report" -ForegroundColor White
  Write-Host "Direction: $($Report.direction)  |  Command: $($Report.command)  |  $($Report.timestamp)" -ForegroundColor DarkGray
  Write-Host ""

  # Preflight
  if ($Report.preflight) {
    $pf = $Report.preflight
    Write-Host "## Preflight" -ForegroundColor White

    if ($pf.metadata) {
      $m = $pf.metadata[0]
      Write-Host "  Database: $($m.DatabaseName)  |  ModelInfo: $($m.ModelInfoDatabase)" -ForegroundColor DarkGray
    }

    if ($pf.productType) {
      Write-Host "  ProductType:" -ForegroundColor Gray
      foreach ($pt in $pf.productType) {
        Write-Host "    $($pt.TableName): $($pt.ProductType)" -ForegroundColor Gray
      }
    }

    if ($pf.modelMap -and $pf.modelMap.Count -gt 0) {
      Write-Host ""
      Write-Host "  Model Map ($($pf.modelMap.Count) entries):" -ForegroundColor Gray
      Write-Host "  SourceModel          -> TargetModel           Rule                 Refs" -ForegroundColor DarkGray
      foreach ($mm in $pf.modelMap) {
        $src = ($mm.SourceModel + "                      ").Substring(0, 22)
        $tgt = ($mm.TargetModel + "                      ").Substring(0, 22)
        $rule = ($mm.RuleApplied + "                     ").Substring(0, 20)
        $color = if ($mm.TargetModelInfoID -eq 'NULL' -or -not $mm.TargetModelInfoID) { "Red" } else { "Gray" }
        Write-Host "  $src -> $tgt $rule $($mm.TotalRefs)" -ForegroundColor $color
      }
    }

    if ($pf.unmapped -and $pf.unmapped.Count -gt 0) {
      Write-Host ""
      Write-Host "  UNMAPPED MODELS ($($pf.unmapped.Count)):" -ForegroundColor Red
      foreach ($u in $pf.unmapped) {
        Write-Host "    $($u.SourceModel) -> $($u.TargetModel) ($($u.TotalRefs) refs)" -ForegroundColor Red
      }
    }

    if ($pf.orphanStations -and $pf.orphanStations.Count -gt 0) {
      Write-Host ""
      Write-Host "  WARNING: Orphan stations ($($pf.orphanStations.Count)):" -ForegroundColor Yellow
      foreach ($o in $pf.orphanStations) {
        Write-Host "    $($o.AreaName) > $($o.ControlStationName) (ID $($o.ControlStationID))" -ForegroundColor Yellow
      }
    }

    if ($pf.result) {
      $r = $pf.result[0]
      $statusColor = switch ($r.Status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
      Write-Host ""
      Write-Host "  Preflight: $($r.Status)" -ForegroundColor $statusColor
      Write-Host "    Unmapped: $($r.UnmappedCount)  Orphans: $($r.OrphanCount)  Issues: $($r.ProgrammingIssueCount)  CorruptBtn: $($r.CorruptButtonCount)" -ForegroundColor DarkGray
    }

    Write-Host ""
  }

  # Convert
  if ($Report.convert) {
    $cv = $Report.convert
    Write-Host "## Conversion" -ForegroundColor White

    if ($cv.tableUpdates -and $cv.tableUpdates.Count -gt 0) {
      Write-Host "  Table Updates:" -ForegroundColor Gray
      foreach ($tu in $cv.tableUpdates) {
        Write-Host "    $($tu.TableName): $($tu.UpdatedRows) rows" -ForegroundColor Gray
      }
    }

    if ($cv.result) {
      $r = $cv.result[0]
      Write-Host "  Total rows updated: $($r.TotalRowsUpdated)" -ForegroundColor Green
      Write-Host "  Completed: $($r.CompletedTimestamp)" -ForegroundColor DarkGray
    }

    Write-Host ""
  }

  # Verify
  if ($Report.verify) {
    $vf = $Report.verify
    Write-Host "## Verification" -ForegroundColor White

    if ($vf.checks) {
      foreach ($c in $vf.checks) {
        $checkColor = if ($c.Status -eq 'PASS') { 'Green' } else { 'Red' }
        Write-Host "  [$($c.Status)] $($c.CheckName): $($c.Detail)" -ForegroundColor $checkColor
      }
    }

    if ($vf.leftoverDetail -and $vf.leftoverDetail.Count -gt 0) {
      Write-Host ""
      Write-Host "  Leftover model detail:" -ForegroundColor Red
      foreach ($l in $vf.leftoverDetail) {
        Write-Host "    $($l.TableName): $($l.ModelName) (ID $($l.ModelInfoID), $($l.RefCount) refs)" -ForegroundColor Red
      }
    }

    if ($vf.result) {
      $r = $vf.result[0]
      $statusColor = if ($r.OverallStatus -eq 'PASS') { 'Green' } else { 'Red' }
      Write-Host ""
      Write-Host "  Verification: $($r.OverallStatus)" -ForegroundColor $statusColor
    }

    Write-Host ""
  }

  # File paths
  if ($Report.snapshotFile) {
    Write-Host "Snapshot: $($Report.snapshotFile)" -ForegroundColor DarkGray
  }
  if ($Report.rollbackFile) {
    Write-Host "Rollback: $($Report.rollbackFile)" -ForegroundColor Yellow
  }
}

function Write-JsonReport {
  param(
    [hashtable]$Report
  )

  $Report | ConvertTo-Json -Depth 10
}

# ============================================================================
# Main
# ============================================================================

$server = Find-ProjectServer
$resolvedDb = Resolve-DatabaseName -Server $server -Requested $Database
Write-Host "Connected: $resolvedDb" -ForegroundColor DarkGray

$report = @{
  command = $Command
  direction = $Direction
  timestamp = (Get-Date -Format "o")
  database = $resolvedDb
  preflight = $null
  convert = $null
  verify = $null
  snapshotFile = $null
  rollbackFile = $null
}

function Extract-PreflightData {
  param([hashtable]$Sections)

  return @{
    metadata = if ($Sections.ContainsKey('METADATA')) { @($Sections['METADATA']) } else { @() }
    productType = if ($Sections.ContainsKey('PRODUCT_TYPE')) { @($Sections['PRODUCT_TYPE']) } else { @() }
    modelUsage = if ($Sections.ContainsKey('MODEL_USAGE')) { @($Sections['MODEL_USAGE']) } else { @() }
    modelMap = if ($Sections.ContainsKey('MODEL_MAP')) { @($Sections['MODEL_MAP']) } else { @() }
    unmapped = if ($Sections.ContainsKey('UNMAPPED')) { @($Sections['UNMAPPED']) } else { @() }
    orphanStations = if ($Sections.ContainsKey('ORPHAN_STATIONS')) { @($Sections['ORPHAN_STATIONS']) } else { @() }
    programmingIssues = if ($Sections.ContainsKey('PROGRAMMING_ISSUES')) { @($Sections['PROGRAMMING_ISSUES']) } else { @() }
    result = if ($Sections.ContainsKey('PREFLIGHT_RESULT')) { @($Sections['PREFLIGHT_RESULT']) } else { @() }
  }
}

function Extract-ConvertData {
  param([hashtable]$Sections)

  return @{
    tableUpdates = if ($Sections.ContainsKey('TABLE_UPDATES')) { @($Sections['TABLE_UPDATES']) } else { @() }
    productTypeAfter = if ($Sections.ContainsKey('PRODUCT_TYPE_AFTER')) { @($Sections['PRODUCT_TYPE_AFTER']) } else { @() }
    result = if ($Sections.ContainsKey('CONVERT_RESULT')) { @($Sections['CONVERT_RESULT']) } else { @() }
  }
}

function Extract-VerifyData {
  param([hashtable]$Sections)

  $success = $false
  $result = @()
  if ($Sections.ContainsKey('VERIFY_RESULT')) {
    $result = @($Sections['VERIFY_RESULT'])
    foreach ($r in $result) {
      if ($r.OverallStatus -eq 'PASS') { $success = $true }
    }
  }

  return @{
    success = $success
    checks = if ($Sections.ContainsKey('VERIFY_CHECK')) { @($Sections['VERIFY_CHECK']) } else { @() }
    leftoverDetail = if ($Sections.ContainsKey('LEFTOVER_DETAIL')) { @($Sections['LEFTOVER_DETAIL']) } else { @() }
    orphanStations = if ($Sections.ContainsKey('ORPHAN_STATIONS')) { @($Sections['ORPHAN_STATIONS']) } else { @() }
    productType = if ($Sections.ContainsKey('PRODUCT_TYPE')) { @($Sections['PRODUCT_TYPE']) } else { @() }
    result = $result
  }
}

$exitCode = 0

try {
  switch ($Command) {
    'preflight' {
      $pfResult = Run-Preflight -Server $server -Db $resolvedDb -Dir $Direction
      $report.preflight = Extract-PreflightData -Sections $pfResult.sections
      $report.snapshotFile = $pfResult.snapshotFile

      # Check for FAIL status
      if ($report.preflight.result.Count -gt 0 -and $report.preflight.result[0].Status -eq 'FAIL') {
        $exitCode = 1
      }
    }

    'convert' {
      $cvResult = Run-Convert -Server $server -Db $resolvedDb -Dir $Direction
      $report.convert = Extract-ConvertData -Sections $cvResult.sections
    }

    'verify' {
      $vfResult = Run-Verify -Server $server -Db $resolvedDb -Dir $Direction
      $report.verify = Extract-VerifyData -Sections $vfResult.sections

      if (-not $report.verify.success) {
        $exitCode = 1
        if (-not $NoRollback) {
          $report.rollbackFile = New-RollbackScript -Dir $Direction -Db $resolvedDb
          Write-Host "Verification FAILED - rollback script generated." -ForegroundColor Red
        }
      }
    }

    'full' {
      # Phase 1: Preflight
      $pfResult = Run-Preflight -Server $server -Db $resolvedDb -Dir $Direction
      $report.preflight = Extract-PreflightData -Sections $pfResult.sections
      $report.snapshotFile = $pfResult.snapshotFile

      if ($report.preflight.result.Count -gt 0 -and $report.preflight.result[0].Status -eq 'FAIL') {
        Write-Host "Preflight FAILED - aborting pipeline." -ForegroundColor Red
        $exitCode = 1
      } else {
        # Phase 2: Convert
        $cvResult = Run-Convert -Server $server -Db $resolvedDb -Dir $Direction
        $report.convert = Extract-ConvertData -Sections $cvResult.sections

        # Phase 3: Verify
        $vfResult = Run-Verify -Server $server -Db $resolvedDb -Dir $Direction
        $report.verify = Extract-VerifyData -Sections $vfResult.sections

        if (-not $report.verify.success) {
          $exitCode = 1
          if (-not $NoRollback) {
            $report.rollbackFile = New-RollbackScript -Dir $Direction -Db $resolvedDb
            Write-Host "Verification FAILED - rollback script generated." -ForegroundColor Red
          }
        }
      }
    }
  }
} catch {
  $errMsg = $_.Exception.Message
  Write-Host "ERROR: $errMsg" -ForegroundColor Red
  $exitCode = 1
}

# Output report
if ($Json) {
  Write-JsonReport -Report $report
} else {
  Write-MarkdownReport -Report $report
}

exit $exitCode
