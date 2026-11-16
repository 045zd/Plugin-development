# -*- coding: utf-8 -*-
"""生成扩展图标：蓝色圆角底 + 白色日历 + 红色提醒点。"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "assets" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 512  # 以 512 绘制，再缩小，保证抗锯齿


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景：蓝色圆角方块
    pad = 28
    rounded_rect(d, (pad, pad, S - pad, S - pad), 108, (59, 108, 246, 255))

    # 日历主体
    cal = (120, 150, S - 120, S - 96)
    rounded_rect(d, cal, 40, (255, 255, 255, 255))
    # 日历头部条
    d.rounded_rectangle((cal[0], cal[1], cal[2], cal[1] + 96), radius=40, fill=(230, 237, 255, 255))
    d.rectangle((cal[0], cal[1] + 66, cal[2], cal[1] + 96), fill=(230, 237, 255, 255))
    # 两个挂环
    for cx in (S // 2 - 96, S // 2 + 96):
        d.rounded_rectangle((cx - 17, cal[1] - 26, cx + 17, cal[1] + 44), radius=17, fill=(59, 108, 246, 255))
        d.rounded_rectangle((cx - 17, cal[1] - 26, cx + 17, cal[1] + 44), radius=17, fill=(59, 108, 246, 255))

    # 日历上的日期点阵（3x3）
    dot = 34
    gap = 56
    x0 = S // 2 - gap
    y0 = cal[1] + 150
    for row in range(3):
        for col in range(3):
            x = x0 + col * gap
            y = y0 + row * gap
            d.ellipse((x - dot // 2, y - dot // 2, x + dot // 2, y + dot // 2), fill=(205, 216, 240, 255))

    # 红色提醒圆点（右下角）+ 白色感叹号
    cx, cy, r = S - 168, S - 168, 92
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(229, 72, 77, 255))
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, 255), width=10)
    # 感叹号竖条 + 点
    d.rounded_rectangle((cx - 13, cy - 46, cx + 13, cy + 10), radius=13, fill=(255, 255, 255, 255))
    d.ellipse((cx - 13, cy + 26, cx + 13, cy + 52), fill=(255, 255, 255, 255))

    return img


def main():
    base = make_icon()
    sizes = [16, 32, 48, 128]
    for s in sizes:
        resized = base.resize((s, s), Image.LANCZOS)
        path = OUT / f"icon{s}.png"
        resized.save(path, "PNG")
        print(f"OK {path} ({path.stat().st_size} bytes)")
    # 额外生成一个 256 供商店/说明使用
    base.resize((256, 256), Image.LANCZOS).save(OUT / "icon256.png", "PNG")
    print("OK icon256.png")


if __name__ == "__main__":
    sys.exit(main())
