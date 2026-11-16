import re, json, os, glob

from _store import read_blob, store_dir

# 调试用：容错提取存储里的 items 数组（作业/考试条目列表）。
# 扩展 ID 通过环境变量 CXW_EXT_ID 指定，见 _store.py。
d = store_dir()
blob = read_blob(d)
text = blob.decode("utf-8", "ignore")

# 位置 18253 附近有 items[  （从前面探针看到）
i = text.find("items")
print("第一次 items 位置:", i)
print("上下文:", repr(text[i - 80 : i + 160]))

# 手工：从该 [ 开始，用非贪婪 + 深度计数
start = text.find("[", i)
print("\nstart =", start, "字符:", repr(text[start : start + 40]))

depth = 0
in_str = False
esc = False
end = -1
for p in range(start, len(text)):
    ch = text[p]
    if in_str:
        if esc:
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == '"':
            in_str = False
        continue
    if ch == '"':
        in_str = True
    elif ch == "[":
        depth += 1
    elif ch == "]":
        depth -= 1
        if depth == 0:
            end = p + 1
            break
print("end =", end, "长度 =", (end - start) if end > 0 else -1)
if end > 0:
    raw = text[start:end]
    print("尾部:", repr(raw[-120:]))
    try:
        arr = json.loads(raw)
        print("解析成功，%d 条" % len(arr))
    except Exception as e:
        print("解析失败:", e)
