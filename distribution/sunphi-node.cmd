@echo off
setlocal
if "%~1"=="" (
  start "" "%~dp0SunPhi Native Node.exe"
  exit /b
)
"%~dp0resources\app\runtime\node.exe" "%~dp0resources\app\distribution\node.mjs" %*
exit /b %errorlevel%
