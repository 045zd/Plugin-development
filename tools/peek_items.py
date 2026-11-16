import re, json, os, glob, datetime
from collections import Counter

from _store import read_blob, store_dir

# 调试用：提取 items 数组并按需筛选打印（默认筛「实验」类条目）。
# 扩展 ID 通过环境变量 CXW_EXT_ID 指定，见 _store.py。
d = store_dir()
blob = read_blob(d)
text = blob.decode("utf-8", "ignore")

start = text.find("items")
arr_start = text.find("[", start)
print("items 数组起点:", arr_start)

# 逐个解析顶层对象（遇错就跳到下一 "},{" ）
items = []
p = arr_start + 1
n = len(text)
fails = 0
while p < n:
    while p < n and text[p] in " ,\t\r\n":
        p += 1
    if p >= n or text[p] == "]":
        break
    if text[p] != "{":
        # 非对象，中断
        print("中断于", p, repr(text[p : p + 40]))
        break
    depth = 0
    in_str = False
    esc = False
    end = -1
    for q in range(p, n):
        ch = text[q]
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
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = q + 1
                break
    if end < 0:
        break
    raw = text[p:end]
    try:
        obj = json.loads(raw, strict=False)
        items.append(obj)
        p = end
    except Exception:
        fails += 1
        nxt = text.find("},", p + 1)
        if nxt < 0:
            break
        p = nxt + 2
        if fails > 5:
            print("失败过多，停止")
            break

print("解析出 %d 个条目，失败 %d 次\n" % (len(items), fails))

labs = [i for i in items if isinstance(i, dict) and "实验" in str(i.get("title", ""))]
print("实验类 %d 条：\n" % len(labs))
now = datetime.datetime.now()
for it in labs:
    dl = it.get("deadline")
    dls = past = ""
    if isinstance(dl, (int, float)) and dl > 1e12:
        dt = datetime.datetime.fromtimestamp(dl / 1000)
        dls = dt.strftime("%m-%d %H:%M")
        past = "已过!" if dt <= now else "未过"
    print(
        "|%-10s| %-28s | %-9s | dl=%-11s %-5s | %s"
        % (
            str(it.get("course", ""))[:10],
            str(it.get("title", ""))[:28],
            str(it.get("status", ""))[:9],
            dls,
            past,
            str(it.get("deadlineText", ""))[:18],
        )
    )

print("\n=== 状态分布 ===")
for s, c in Counter(str(i.get("status", "")) for i in items).most_common():
    print("  %-10s %d" % (s or "(空)", c))
