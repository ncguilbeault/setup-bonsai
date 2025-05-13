@echo off
setlocal
cd ../setup-bonsai-test/
set INPUT_ENVIRONMENT-PATHS=**/.bonsai/
::set INPUT_ENVIRONMENT-PATHS=docs/examples/examples/HiddenMarkovModels/ExtendedModelConfiguration/.bonsai/
::set INPUT_INJECT-PACKAGES=%~dp0scratch/packages/**/*.nupkg
set INPUT_INJECT-PACKAGES=test-packages/*.nupkg
set INPUT_ENABLE-CACHE=true

set __TEST_INVOCATION_ID=DummyInvocationId
set RUNNER_DEBUG=1
set RUNNER_TEMP=%~dp0scratch/RUNNER_TEMP/
set RUNNER_TOOL_CACHE=%~dp0scratch/RUNNER_TOOL_CACHE/

set NODE_OPTIONS=--enable-source-maps

set GITHUB_STATE=%~dp0scratch/GITHUB_STATE
break > %GITHUB_STATE%

:: Clean up modifications made by previous tests
node %~dp0dist\main.js --restore-modified

node %~dp0dist\main.js
set MAIN_SUCCESS=%ERRORLEVEL%

echo.
echo ================================================================================================================================================
echo.

if "%MAIN_SUCCESS%" == "0" (
    node %~dp0dist\post.js
) else (
    echo Skipped post action, main action failed.
)
