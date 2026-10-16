@echo off
setlocal
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell is required. 1>&2
  exit /b 1
)
if not exist "%~dp0install.ps1" (
  echo Keep install.ps1 beside install.cmd. 1>&2
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %errorlevel%
