# Авто-деплой: тянет свежий main и применяет изменения.
# Запускается Планировщиком задач (через deploy-hidden.vbs, без окна) раз в пару минут.
# Бэкенд крутится под PM2 (octo-api) — после изменений его перезапускаем.
$ErrorActionPreference = 'Stop'
# Гарантируем, что git виден, даже если у задачи минимальный PATH.
$env:Path += ";C:\Program Files\Git\cmd"
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
# Перезапускаем бэкенд под PM2, если менялись файлы сервера.
if ($changed -match '^server/') {
  pm2 restart octo-api
}

"$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))  $before -> $after" |
  Out-File -Append -Encoding utf8 (Join-Path $PSScriptRoot 'deploy.log')
