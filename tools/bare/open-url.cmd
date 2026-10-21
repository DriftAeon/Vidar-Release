@echo off
rem Bare Claude BROWSER opener: forwards the one URL to open-url.ps1, which hands it to ShellExecute under a fresh logon env.
pwsh.exe -NoProfile -NonInteractive -File "%~dp0open-url.ps1" %*
exit /b %errorlevel%
