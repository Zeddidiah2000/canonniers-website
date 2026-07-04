# Builds the compact columnar assets/stats-leaders.json for stats.html
# Source: the 15U + 17U league-leaderboard CSVs produced by the GameChanger sweep.
# Re-run after every sweep:  pwsh scripts/gen-leaders.ps1
$ErrorActionPreference = 'Stop'
$inv  = [Globalization.CultureInfo]::InvariantCulture
$lead = 'C:\Users\Potato\Documents\Canonniers Website\Updates\stats\leaderboards'
$out  = 'C:\Users\Potato\Documents\Canonniers Website\repo-working\assets\stats-leaders.json'

$batCols = @('GP','PA','AB','H','2B','3B','HR','RBI','R','BB','SO','SB','AVG','OBP','SLG','OPS','QAB%','BABIP')
$pitCols = @('IP','W','L','SV','SO','BB','H','R','ER','HR','ERA','WHIP','BAA','FIP','K/BB','K/G')

$teams   = New-Object System.Collections.Generic.List[string]
$teamIdx = @{}
function TeamId($name){ if(-not $teamIdx.ContainsKey($name)){ $teamIdx[$name] = $teams.Count; $teams.Add($name) }; $teamIdx[$name] }

# '' -> null ; integer -> int ; decimal -> number ; else string
function Val($s){
  if($null -eq $s -or "$s".Trim() -eq ''){ return $null }
  $t = "$s".Trim()
  if($t -match '^-?\d+$'){ return [int]$t }
  $d = 0.0; if([double]::TryParse($t,[Globalization.NumberStyles]::Float,$inv,[ref]$d)){ return $d }
  return $t
}

function Load($file,$cols){
  $rows = @()
  Import-Csv $file | ForEach-Object {
    $r = $_
    $arr = New-Object System.Collections.ArrayList
    [void]$arr.Add($r.Player)
    [void]$arr.Add((TeamId $r.Team))
    [void]$arr.Add((Val $r.Number))
    foreach($c in $cols){ [void]$arr.Add((Val $r.$c)) }
    $rows += ,$arr
  }
  ,$rows
}

$b15 = Load "$lead\15U-AAA_batting_leaderboard.csv"  $batCols
$p15 = Load "$lead\15U-AAA_pitching_leaderboard.csv" $pitCols
$b17 = Load "$lead\17U-AAA_batting_leaderboard.csv"  $batCols
$p17 = Load "$lead\17U-AAA_pitching_leaderboard.csv" $pitCols

$obj = [ordered]@{
  generated = (Get-Date).ToString('yyyy-MM-dd')
  cols  = [ordered]@{ b = $batCols; p = $pitCols }
  teams = $teams.ToArray()
  b15 = $b15; p15 = $p15; b17 = $b17; p17 = $p17
}
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
$obj | ConvertTo-Json -Depth 6 -Compress | Set-Content $out -Encoding utf8
"wrote {0}  ({1:N1} KB) | {2} teams | b15 {3}  p15 {4}  b17 {5}  p17 {6}" -f `
  (Split-Path $out -Leaf), ((Get-Item $out).Length/1KB), $teams.Count, $b15.Count, $p15.Count, $b17.Count, $p17.Count