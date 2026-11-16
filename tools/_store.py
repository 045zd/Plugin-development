"""定位 Edge 扩展的 LevelDB 存储目录（调试工具共用）。

扩展的 chrome.storage 数据存在这里：
  %LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Local Extension Settings\\<扩展ID>\\
里面是 LevelDB 文件（*.log 明文 + *.ldb），键是裸字符串，值是 JSON。

扩展 ID 因安装路径不同而不同，所以不写死在代码里：
edge://extensions/ 页面上能直接看到，或从下面的方式推导。

用法：
    set CXW_EXT_ID=<你的扩展ID>
"""

import os


def store_dir(ext_id=None):
    """返回扩展存储目录。找不到扩展 ID 时抛 SystemExit 并给出提示。"""
    ext_id = (ext_id or os.environ.get("CXW_EXT_ID", "")).strip()
    if not ext_id:
        raise SystemExit(
            "请先设置环境变量 CXW_EXT_ID 为扩展 ID。\n"
            "打开 edge://extensions/ 即可看到（形如 hmcgjlcgmnngjngmkfdlfhcdnejjgpdp）。\n"
            "PowerShell:  $env:CXW_EXT_ID='你的ID'"
        )
    local = os.environ.get("LOCALAPPDATA") or os.path.expanduser(
        r"~\AppData\Local"
    )
    return os.path.join(
        local,
        "Microsoft",
        "Edge",
        "User Data",
        "Default",
        "Local Extension Settings",
        ext_id,
    )


def read_blob(directory):
    """把目录下所有 LevelDB 文件按序读成一个字节串。"""
    import glob

    blob = b""
    pattern = sorted(glob.glob(os.path.join(directory, "*.log")))
    pattern += sorted(glob.glob(os.path.join(directory, "*.ldb")))
    for f in pattern:
        with open(f, "rb") as fh:
            blob += fh.read()
    return blob
