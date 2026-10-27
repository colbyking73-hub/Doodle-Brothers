# Publishes a new version of Doodle Brothers.
#   .\release.ps1            -> 0.1.0 becomes 0.1.1 (small update)
#   .\release.ps1 minor      -> 0.1.0 becomes 0.2.0 (bigger update)
# It bumps the version, commits everything, and pushes a version tag to GitHub. GitHub then builds the
# installer and publishes it as a Release (takes ~5 minutes); everyone's installed game updates itself.
param([ValidateSet('patch', 'minor', 'major')] [string]$Bump = 'patch')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$pkgPath = Join-Path $PSScriptRoot 'package.json'
$pkg = Get-Content $pkgPath -Raw
if ($pkg -notmatch '"version":\s*"(\d+)\.(\d+)\.(\d+)"') { throw 'Could not find the version in package.json' }
$maj = [int]$Matches[1]; $min = [int]$Matches[2]; $pat = [int]$Matches[3]
switch ($Bump) { 'major' { $maj++; $min = 0; $pat = 0 } 'minor' { $min++; $pat = 0 } default { $pat++ } }
$ver = "$maj.$min.$pat"
$pkg = $pkg -replace '"version":\s*"\d+\.\d+\.\d+"', "`"version`": `"$ver`""
[System.IO.File]::WriteAllText($pkgPath, $pkg, (New-Object System.Text.UTF8Encoding $false))

git add -A
# patch.json = what QUICK updates need (see updater.js): the version, the app-shell id, and a hash of every game file.
# (Hashes must match updater.js exactly: text files without a BOM and with \r removed, sha256 hex.)
& (Join-Path $PSScriptRoot 'make-patch.ps1') -Version $ver
git add patch.json
git commit -m "Release v$ver"
git tag "v$ver"
git push
git push origin "v$ver"
Write-Host ""
Write-Host "Pushed v$ver. GitHub is building it now - check the Actions tab; the installer appears under Releases in ~5 minutes."
