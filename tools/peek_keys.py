import re, os, glob

from _store import read_blob, store_dir

# 调试用：列出存储里所有键名，并打印每个键附近的原文（用于发现新字段）。
# 扩展 ID 通过环境变量 CXW_EXT_ID 指定，见 _store.py。
d = store_dir()
blob = read_blob(d)
text = blob.decode("utf-8", "ignore")

# 列出所有形如 "key": 出现，统计哪些是存储键
keys = {}
for m in re.finditer(r'"([A-Za-z][A-Za-z0-9_]{2,40})"\s*:', text):
    k = m.group(1)
    keys[k] = keys.get(k, 0) + 1
print("=== 候选键（按出现次数）===")
for k, c in sorted(keys.items(), key=lambda x: -x[1])[:60]:
    print("%-30s %d" % (k, c))

print()
print("=== 是否存在 'items' ===", '"items"' in text)
print("=== 是否存在 'reportCheckState' ===", '"reportCheckState"' in text)
print("=== 是否存在 'config' ===", '"config"' in text)

# 找所有 【key 的直接位置上下文
for kw in ["items", "reportCheckState", "scanMeta", "config"]:
    idxs = [m.start() for m in re.finditer('"' + kw + '"', text)]
    print("\n### %s 出现 %d 次" % (kw, len(idxs)))
    for i in idxs[:3]:
        print("   ...", text[max(0, i - 60) : i + 120].replace("\n", "\\n"))
