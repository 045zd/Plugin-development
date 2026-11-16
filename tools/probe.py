# -*- coding: utf-8 -*-
"""调研脚本：抓取学习通公开页面与开源参考项目源码，供开发期分析用。

只做只读抓取，不写入任何账号信息。
"""
import json
import ssl
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "references"
REF.mkdir(exist_ok=True)

CTX = ssl._create_unverified_context()
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"
)


def fetch(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    with urllib.request.urlopen(req, context=CTX, timeout=timeout) as resp:
        return resp.read()


def save(name, data):
    p = REF / name
    p.write_bytes(data)
    print(f"SAVED {name} ({len(data)} bytes)")


def main():
    targets = [
        (
            "opencli-assignments.js",
            "https://raw.githubusercontent.com/jackwener/opencli/main/clis/chaoxing/assignments.js",
        ),
        (
            "opencli-exams.js",
            "https://raw.githubusercontent.com/jackwener/opencli/main/clis/chaoxing/exams.js",
        ),
        (
            "opencli-utils.js",
            "https://raw.githubusercontent.com/jackwener/opencli/main/clis/chaoxing/utils.js",
        ),
        (
            "opencli-auth.js",
            "https://raw.githubusercontent.com/jackwener/opencli/main/clis/chaoxing/auth.js",
        ),
    ]
    for name, url in targets:
        try:
            save(name, fetch(url))
        except Exception as exc:  # noqa: BLE001
            print(f"FAILED {name}: {exc}")

    # 从 opencli 的文件树里找出 chaoxing 相关源码路径
    tree_file = REF / "opencli-tree.json"
    if tree_file.exists():
        try:
            tree = json.loads(tree_file.read_text("utf-8"))
            paths = [
                item["path"]
                for item in tree.get("tree", [])
                if "chaoxing" in item["path"].lower()
            ]
            print("OPENCLI_CHAOXING_PATHS:")
            for p in paths:
                print(" ", p)
            (REF / "opencli-chaoxing-paths.txt").write_text(
                "\n".join(paths), "utf-8"
            )
        except Exception as exc:  # noqa: BLE001
            print(f"TREE_PARSE_FAILED: {exc}")


if __name__ == "__main__":
    main()
