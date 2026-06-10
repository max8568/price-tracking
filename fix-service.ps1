# 一次性修復腳本：清掉孤兒 tracker 程序後重啟服務（需系統管理員執行）
$log = "$PSScriptRoot\fix-service.log"
"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $log

try { Stop-Service 'pricetrackingbot.exe' -Force -ErrorAction Stop; "Stop-Service OK" | Out-File $log -Append } catch { "Stop-Service: $($_.Exception.Message)" | Out-File $log -Append }
Start-Sleep -Seconds 2

# 殺掉所有 price-tracking 相關的 node 程序（孤兒 tracker / wrapper）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.CommandLine -match 'price-tracking') {
    "Killing PID $($_.ProcessId): $($_.CommandLine)" | Out-File $log -Append
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { "  kill failed: $($_.Exception.Message)" | Out-File $log -Append }
  }
}
Start-Sleep -Seconds 2

$port = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
"Port 3001 after cleanup: $(if ($port) { 'STILL HELD by ' + $port.OwningProcess } else { 'free' })" | Out-File $log -Append

try { Start-Service 'pricetrackingbot.exe' -ErrorAction Stop; "Start-Service OK" | Out-File $log -Append } catch { "Start-Service: $($_.Exception.Message)" | Out-File $log -Append }
Start-Sleep -Seconds 5
"Final status: $((Get-Service 'pricetrackingbot.exe').Status)" | Out-File $log -Append
