# Writes patch.json for QUICK updates (called by release.ps1). Must hash files exactly the way updater.js does.
param([Parameter(Mandatory)] [string]$Version, [string]$Out = 'patch.json')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false
$sha = [System.Security.Cryptography.SHA256]::Create()
function Hex($bytes) { ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '' }
function NormText($path) {
  $t = [System.Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $path)))
  if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
  return $t.Replace("`r", '')
}
function NormBytes($rel) {
  if ($rel -match '\.(html|js|json|css|txt)$') { return ,$utf8.GetBytes((NormText $rel)) }
  return ,[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $rel))
}

# the app shell id: main.js + preload.js + updater.js + the Electron version
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$shellText = ''
foreach ($f in 'main.js', 'preload.js', 'updater.js') { $shellText += (NormText $f) + "`n--`n" }
$shellText += 'electron@' + $pkg.devDependencies.electron
$shell = (Hex $utf8.GetBytes($shellText)).Substring(0, 16)

# the game files (the ones the installer ships, and that GitHub has - tracked by git)
$game = '^(index\.html|net\.js|lib/.+|sounds/[^/]+\.js|sounds/menu-mix-[^/]+\.mp3|build/icon\.png)$'
$files = [ordered]@{}
foreach ($rel in (git ls-files | Where-Object { $_ -match $game } | Sort-Object)) {
  $b = NormBytes $rel
  $files[$rel] = [ordered]@{ hash = (Hex $b); size = $b.Length }
}
$manifest = [ordered]@{ version = $Version; shell = $shell; files = $files }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot $Out), ($manifest | ConvertTo-Json -Depth 5), $utf8)
"patch.json: v$Version, shell $shell, $($files.Count) files"
