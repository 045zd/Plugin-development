@echo off
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem 检查 python 是否可用
where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo [错误] 没有找到 python 命令。
    echo.
    echo 请先安装 Python 3.10 或更高版本：
    echo     https://www.python.org/downloads/
    echo 安装时务必勾选 "Add python.exe to PATH"，然后重新打开本窗口。
    echo 如果已经安装但仍提示找不到，可在「设置 - 应用执行别名」中
    echo 关闭 Microsoft Store 的 python 别名，或把 Python 加入 PATH。
    echo.
    pause
    exit /b 1
)

rem 检查 Python 版本是否 >= 3.10
python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 (
    echo.
    echo [错误] 需要 Python 3.10 或更高版本。
    echo 当前版本：
    python -V
    echo.
    echo 请升级 Python 后重试：https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

python mail_proxy.py %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [提示] 邮件代理已退出，退出码 %EXIT_CODE%。
    echo 日志见同目录 proxy.log，配置说明见 README.md。
    pause
)

exit /b %EXIT_CODE%
