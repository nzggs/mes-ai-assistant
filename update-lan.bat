@echo off
REM ============================================================
REM  服务器：用"安装包"就地升级（保留数据与配置）
REM  用法：把发布包解压后，在解压目录里运行：
REM        update-lan.bat  <当前安装目录>
REM  例：  update-lan.bat  D:\mes-ai
REM  脚本会自动：停服 -> 备份 server/data -> 同步新程序（保留 server/data 与 server/.env）
REM            -> 把根 .env 的 VITE_ADMIN_TOKEN 同步进 server/.env 的 ADMIN_TOKEN
REM            -> 放行防火墙 -> 重启服务
REM ============================================================
set RELEASE=%~dp0
set INSTALL=%1
if "%INSTALL%"=="" (
  echo 用法：update-lan.bat ^<当前安装目录^>
  echo 例：  update-lan.bat D:\mes-ai
  pause & exit /b 1
)
if not exist "%INSTALL%\server\index.js" (
  echo 找不到安装目录中的 server\index.js：%INSTALL%
  pause & exit /b 1
)

echo [0] 停止旧服务（端口 3001）...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
  taskkill /PID %%p /F >nul 2>&1
)
timeout /t 2 >nul

echo [1] 备份旧数据 server/data ...
set STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%-%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%
set STAMP=%STAMP: =0%
set BAK=%INSTALL%\..\mes-ai-data-backup-%STAMP%
if not exist "%BAK%" mkdir "%BAK%"
xcopy /E /I /Y "%INSTALL%\server\data" "%BAK%" >nul
echo     备份至：%BAK%

echo [2] 同步新程序（排除 node_modules 与 server\data，保留 server\.env）...
if exist "%INSTALL%\server\.env" copy /Y "%INSTALL%\server\.env" "%TEMP%\mes-env-bak" >nul
robocopy "%RELEASE%" "%INSTALL%" /E /NFL /NDL /NJH /NJS /XD node_modules "server\data" >nul
if exist "%TEMP%\mes-env-bak" copy /Y "%TEMP%\mes-env-bak" "%INSTALL%\server\.env" >nul
echo     同步完成。

echo [3] 同步管理员令牌：根 .env 的 VITE_ADMIN_TOKEN -> server\.env 的 ADMIN_TOKEN ...
powershell -NoProfile -Command ^
  "$r=Join-Path '%RELEASE%' '.env'; $s=Join-Path '%INSTALL%' 'server\.env'; ^
   if(Test-Path $r){$vt=(Get-Content $r -Raw) -replace '(?m)^VITE_ADMIN_TOKEN=.*','' -split \"`n\" | Where-Object{$_ -match 'VITE_ADMIN_TOKEN='}; $v=($vt[0] -split '=',2)[1].Trim(); ^
   if($v){$lines=@(); $found=$false; if(Test-Path $s){$lines=Get-Content $s}; foreach($l in $lines){ if($l -match '^ADMIN_TOKEN='){$lines[$lines.IndexOf($l)]='ADMIN_TOKEN='+$v; $found=$true}}; if(-not $found){$lines+='ADMIN_TOKEN='+$v}; Set-Content $s ($lines -join \"`n\"); Write-Host ('     已同步 ADMIN_TOKEN='+$v)}}"
echo     令牌同步完成。

echo [4] 确保依赖存在...
if not exist "%INSTALL%\node_modules" (
  echo     node_modules 缺失，执行 npm install ...
  cd /d "%INSTALL%"
  call npm install --omit=dev >nul 2>&1
)

echo [5] 放行防火墙 3001 入站...
netsh advfirewall firewall add rule name="MES-AI-Assistant-3001" dir=in action=allow protocol=TCP localport=3001 >nul 2>&1

echo [6] 启动服务（监听 0.0.0.0:3001）...
cd /d "%INSTALL%"
start "" node server/index.js > server-run.log 2>&1
timeout /t 3 >nul
curl -s -o nul -w "health=%{http_code}\n" http://127.0.0.1:3001/api/health
echo 升级完成。访问 http://^<服务器IP^>:3001
pause
