# Авто-деплой: тянет свежий main и переустанавливает зависимости только если
# они изменились. Запускается Планировщиком задач раз в пару минут.
# Бэкенд (node --watch) и Vite сами подхватывают изменения файлов, поэтому
# перезапускать процессы тут не нужно.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$before = git rev-parse HEAD
git fetch origin --quiet
$after = git rev-parse origin/main

if ($before -eq $after) { exit 0 }

$changed = git diff --name-only $before $after
git reset --hard origin/main | Out-Null

if ($changed -match 'server/package(-lock)?\.json') {
  npm install --prefix server --no-audit --no-fund
}
if ($changed -match 'client/package(-lock)?\.json') {
  npm install --prefix client --no-audit --no-fund
}
# Пересобираем фронт, если менялись файлы клиента (его отдаёт бэкенд из dist).
if ($changed -match '^client/') {
  npm --prefix client run build
}

"$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))  $before -> $after" |
  Out-File -Append -Encoding utf8 (Join-Path $PSScriptRoot 'deploy.log')
