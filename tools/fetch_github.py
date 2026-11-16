# -*- coding: utf-8 -*-
"""通过 GitHub API 下载参考源码（raw.githubusercontent 较慢，API 更稳）。"""
import base64
import json
import ssl
import urllib.request
from pathlib import Path

REF = Path(__file__).resolve().parent.parent / "references"
CTX = ssl._create_unverified_context()
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)
FILES = ["utils.js", "exams.js", "auth.js", "assignments.js"]
BASE = "https://api.github.com/repos/jackwener/opencli/contents/clis/chaoxing/"


def fetch_json(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"}
    )
    with urllib.request.urlopen(req, context=CTX, timeout=40) as r:
        return json.loads(r.read())


def main():
    for name in FILES:
        try:
            data = fetch_json(BASE + name)
            content = base64.b64decode(data["content"]).decode("utf-8")
            out = REF / f"opencli-{name.replace('.js', '')}.js"
            out.write_text(content, "utf-8")
            print(f"OK {out.name} {len(content)} chars")
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL {name}: {exc}")


if __name__ == "__main__":
    main()
