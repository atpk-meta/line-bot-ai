param(
  [string]$ImagePath = "rich-menu.jpg",
  [string]$MenuPath = "rich-menu.json"
)

$ErrorActionPreference = "Stop"

if (-not $env:LINE_CHANNEL_ACCESS_TOKEN) {
  throw "Missing LINE_CHANNEL_ACCESS_TOKEN"
}

if (-not (Test-Path -LiteralPath $MenuPath)) {
  throw "Rich menu JSON not found: $MenuPath"
}

if (-not (Test-Path -LiteralPath $ImagePath)) {
  throw "Rich menu image not found: $ImagePath"
}

$headers = @{
  Authorization = "Bearer $env:LINE_CHANNEL_ACCESS_TOKEN"
  "Content-Type" = "application/json"
}

$menuBody = Get-Content -Raw -LiteralPath $MenuPath
$menu = Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.line.me/v2/bot/richmenu" `
  -Headers $headers `
  -Body $menuBody

$menuId = $menu.richMenuId
if (-not $menuId) {
  throw "LINE did not return richMenuId"
}

Invoke-RestMethod `
  -Method Post `
  -Uri "https://api-data.line.me/v2/bot/richmenu/$menuId/content" `
  -Headers @{
    Authorization = "Bearer $env:LINE_CHANNEL_ACCESS_TOKEN"
    "Content-Type" = "image/jpeg"
  } `
  -InFile $ImagePath

Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.line.me/v2/bot/user/all/richmenu/$menuId" `
  -Headers @{
    Authorization = "Bearer $env:LINE_CHANNEL_ACCESS_TOKEN"
  }

Write-Host "Rich menu installed: $menuId"
