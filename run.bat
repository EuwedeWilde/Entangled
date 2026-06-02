@echo off


setlocal enableextensions
cd /d "%~dp0"


set "REPO_URL=https://github.com/REPLACE_ME/REPLACE_ME.git"
set "REPO_BRANCH=main"

echo.
echo === Entangled launcher ===
echo Working directory: %CD%
echo.


echo %CD% | findstr /c:"(" >nul
if not errorlevel 1 (
    echo ERROR: the current path contains a parenthesis ^( or ^):
    echo        %CD%
    echo.
    echo        Windows cmd.exe cannot reliably run batch files from paths
    echo        with parentheses. This usually happens when a folder is
    echo        downloaded multiple times and Windows renames it "entangled^(1^)",
    echo        "entangled^(5^)", and so on.
    echo.
    echo        Please rename the folder to remove the parenthesised number
    echo        ^(or move/extract it to a clean folder like C:\entangled^)
    echo        and re-run this script.
    goto :error
)

echo [1/5] Checking GitHub for updates...


if "%REPO_URL%"=="https://github.com/REPLACE_ME/REPLACE_ME.git" (
    echo       REPO_URL not configured in run.bat - skipping update check.
    goto :after_git
)
if "%REPO_URL%"=="" (
    echo       REPO_URL not configured in run.bat - skipping update check.
    goto :after_git
)

where git >nul 2>nul
if errorlevel 1 (
    echo       git is not on PATH - skipping update check.
    echo       Install git from https://git-scm.com/ to enable auto-updates.
    goto :after_git
)

if exist ".git" goto :git_existing


echo       No .git folder yet - bootstrapping from %REPO_URL% ...
git init --quiet
if errorlevel 1 (
    echo       WARNING: git init failed. Skipping update check.
    goto :after_git
)
git remote add origin "%REPO_URL%"
if errorlevel 1 (
    git remote set-url origin "%REPO_URL%" >nul 2>nul
)
git fetch origin --quiet
if errorlevel 1 (
    echo       WARNING: git fetch failed - check the REPO_URL and your connection.
    goto :after_git
)

git checkout -B "%REPO_BRANCH%" "origin/%REPO_BRANCH%" --quiet
if errorlevel 1 (
    echo       WARNING: could not check out branch "%REPO_BRANCH%".
    echo                The repository may use a different default branch.
    goto :after_git
)
echo       Bootstrap complete - now tracking %REPO_URL% (%REPO_BRANCH%).
goto :after_git

:git_existing
git fetch origin --quiet 2>nul
if errorlevel 1 (
    echo       Skipped: git fetch failed - offline or remote unreachable.
    goto :after_git
)

set "BEHIND="
for /f "tokens=*" %%a in ('git rev-list --count HEAD..origin/%REPO_BRANCH% 2^>nul') do set "BEHIND=%%a"

if "%BEHIND%"=="" (
    echo       Could not compare against origin/%REPO_BRANCH%. Update check skipped.
    goto :after_git
)
if "%BEHIND%"=="0" (
    echo       Up to date.
    goto :after_git
)

echo       %BEHIND% new commit(s) available - pulling updates...

set "STASHED=0"
git stash push --include-untracked --quiet -m "auto-stash by run.bat" >nul 2>nul
if not errorlevel 1 (
    git stash list | findstr /c:"auto-stash by run.bat" >nul 2>nul
    if not errorlevel 1 set "STASHED=1"
)

git pull --ff-only --quiet origin "%REPO_BRANCH%"
if errorlevel 1 (
    echo       WARNING: git pull failed.
    echo                The launcher will continue with the current code.
    if "%STASHED%"=="1" (
        git stash pop --quiet >nul 2>nul
    )
    goto :after_git
)

if "%STASHED%"=="1" (
    git stash pop --quiet >nul 2>nul
    if errorlevel 1 (
        echo       Note: pulled OK, but could not auto-restore local runtime files.
        echo             Run "git stash pop" manually in this folder if you need them.
    )
)

echo       Updated to latest %REPO_BRANCH%.

:after_git
echo.

echo [2/5] Checking Python virtualenv...

where python >nul 2>nul
if errorlevel 1 (
    echo       ERROR: python is not on PATH.
    echo              Install Python 3.10+ from https://www.python.org/downloads/
    echo              and re-run this script.
    goto :error
)

set "VENV_PY=.venv\Scripts\python.exe"
set "FRESH_VENV=0"

if exist "%VENV_PY%" (
    echo       Found .venv.
    goto :after_venv
)

echo       No .venv found - creating one at %CD%\.venv ...
python -m venv .venv
if errorlevel 1 (
    echo       ERROR: failed to create virtualenv. Aborting.
    goto :error
)
echo       Virtualenv created.
set "FRESH_VENV=1"

:after_venv
echo.

echo [3/5] Installing Python packages...

"%VENV_PY%" -m pip install --upgrade pip --quiet

if not exist "server\requirements.txt" (
    echo       No requirements.txt found at server\requirements.txt - skipping.
    goto :after_pip
)

if "%FRESH_VENV%"=="1" (
    echo       Fresh venv - full install. This may take a few minutes...
    "%VENV_PY%" -m pip install -r server\requirements.txt
) else (
    echo       Refreshing requirements - silent if already satisfied...
    "%VENV_PY%" -m pip install -r server\requirements.txt --quiet
)

if errorlevel 1 (
    echo       WARNING: some packages may have failed to install.
    echo                The static server and feedback server only need the
    echo                Python standard library, so they should still work.
    echo                Training requires torch + stable-baselines3.
) else (
    echo       Packages OK.
)

:after_pip
echo.

if not exist "server\email_config.json" (
    echo Note: no email_config.json yet - the feedback server will write
    echo       a template on first start. Edit it with real SMTP credentials
    echo       before the camera button can deliver submissions.
    echo.
)

echo [4/5] Starting servers in two new terminals...

set "PYEXE=%CD%\.venv\Scripts\python.exe"

if not exist "%PYEXE%" (
    echo       ERROR: %PYEXE%
    echo              not found. Was the venv created? Try deleting the .venv
    echo              folder and re-running this script.
    goto :error
)

start "Entangled static server (port 8000)" cmd /k ""%PYEXE%" -m http.server 8000 || pause"
start "Entangled training server (port 8001)" cmd /k ""%PYEXE%" server/train_server.py --host 127.0.0.1 --port 8765 || pause"

echo       Two terminal windows opened.
echo       Close them to stop the servers.
echo.

timeout /t 10 /nobreak >nul

echo [5/5] Opening http://localhost:8000/ ...
start "" "http://localhost:8000/sandbox.html"

echo.
echo === Done ===
echo.
echo Tip: the train.html page also needs the PPO trainer. To start it,
echo      open a fresh terminal in this folder and run:
echo          .venv\Scripts\python.exe server\train_server.py
echo.
echo This launcher window stays open so you can read the log.
echo Press any key to close it (the two server windows will keep running).
pause >nul
endlocal
exit /b 0

:error
echo.
echo === Launcher aborted ===
echo Press any key to close this window.
pause >nul
endlocal
exit /b 1
