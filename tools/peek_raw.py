import re, os, glob

from _store import read_blob, store_dir

# 调试用：把存储原文按可读片段切开，快速看里面写了什么。
# 扩展 ID 通过环境变量 CXW_EXT_ID 指定，见 _store.py。
d = store_dir()
blob = read_blob(d)
print("字节数:", len(blob))

# LevelDB log 是分块（32KB block）+ 7 字节记录头。
# 直接找 UTF-8 可读片段打印，观察键名格式。
text = blob.decode("utf-8", "ignore")

for kw in ["items", "reportCheckState", "scanMeta", "config"]:
    print("\n" + "=" * 70)
    print("### 关键字:", kw)
    for m in list(re.finditer(re.escape(kw), text))[:5]:
        i = m.start()
        seg = text[max(0, i - 120) : i + 200]
        seg = seg.replace("\x00", "·").replace("\n", "\\n").replace("\r", "")
        print("  位置 %d: %s" % (i, seg))
