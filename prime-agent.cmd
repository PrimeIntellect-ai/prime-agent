@echo off
setlocal DisableDelayedExpansion
node "%~dp0scripts\run-prime-agent.mjs" %*
exit /b %errorlevel%
