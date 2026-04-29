param(
  [string]$InputFile,
  [string]$Query,
  [string]$Database = "AUTO",
  [switch]$ShowServer
)

$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Find-ProjectServer {
  $pipes = Get-ChildItem "\\.\pipe\" |
    Select-Object -ExpandProperty Name |
    Where-Object { $_ -like "*LOCALDB*" }

  if (-not $pipes) {
    throw "No LOCALDB pipe found."
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

if (-not $InputFile -and -not $Query) {
  throw "Provide either -InputFile <path.sql> or -Query <sql>."
}

$server = Find-ProjectServer
$resolvedDb = Resolve-DatabaseName -Server $server -Requested $Database

if ($ShowServer) {
  Write-Output "SERVER|$server"
  Write-Output "DATABASE|$resolvedDb"
}

if ($InputFile) {
  & sqlcmd -S $server -E -No -d $resolvedDb -b -W -s "|" -i $InputFile
  exit $LASTEXITCODE
}

& sqlcmd -S $server -E -No -d $resolvedDb -b -W -s "|" -Q $Query
exit $LASTEXITCODE
