"""校验 extension/manifest.json 引用的文件都存在，且源码是合法 UTF-8。

用法：python tools/validate.py
"""

import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
mf = json.loads((root / "extension" / "manifest.json").read_text("utf-8"))
print("name =", mf["name"])
print("version =", mf["version"], "manifest_version =", mf["manifest_version"])
refs = [
    mf["background"]["service_worker"],
    mf["action"]["default_popup"],
    mf["options_page"],
    mf["content_scripts"][0]["js"][0],
]
refs += list(mf["icons"].values()) + list(mf["action"]["default_icon"].values())
bad = [r for r in refs if not (root / "extension" / r).exists()]
print("引用文件缺失:", bad if bad else "无（全部存在）")
# 检查所有源码文件均为 UTF-8 可解码
for p in (
    list((root / "extension").rglob("*.js"))
    + list((root / "extension").rglob("*.html"))
    + list((root / "extension").rglob("*.css"))
):
    p.read_text("utf-8")
print("源码 UTF-8 校验: OK")
if bad:
    sys.exit(1)
