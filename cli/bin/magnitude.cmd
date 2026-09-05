@echo off
rem Runs the Magnitude CLI from a source checkout on Windows.
rem `bun run scripts/install-local.ts` places a wrapper that calls this file on PATH.
setlocal
set "REPO_ROOT=%~dp0..\.."
if not exist "%REPO_ROOT%\node_modules" goto :unprepared
if not exist "%REPO_ROOT%\packages\version\src\version.generated.ts" goto :unprepared
bun run "%REPO_ROOT%\cli\src\index.tsx" %*
exit /b %ERRORLEVEL%

:unprepared
echo This Magnitude checkout has not been prepared for running from source.
echo Run the installer once from the repository root:
echo.
echo   cd "%REPO_ROOT%"
echo   bun run install:local
exit /b 1
