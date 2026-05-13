@echo off
:: 아이템스카우트 자동수집 Task Scheduler 등록 스크립트
:: 관리자 권한으로 실행하세요

set SCRIPT_DIR=%~dp0
set PYTHON_PATH=C:\Users\김세름\AppData\Local\Programs\Python\Python312\python.exe
set SCRIPT_PATH=%SCRIPT_DIR%itemscout_crawler.py
set TASK_NAME=ItemScoutCrawler

echo Task Scheduler 등록 중...

schtasks /delete /tn "%TASK_NAME%" /f 2>nul

schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%PYTHON_PATH%\" \"%SCRIPT_PATH%\"" ^
  /sc DAILY ^
  /st 23:50 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f

if %errorlevel% == 0 (
    echo.
    echo [완료] 매일 23:50에 자동 실행 등록됨
    echo 작업 이름: %TASK_NAME%
    echo 스크립트: %SCRIPT_PATH%
) else (
    echo.
    echo [오류] 등록 실패 - 관리자 권한으로 다시 실행하세요
)

pause
