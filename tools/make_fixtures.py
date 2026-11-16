# -*- coding: utf-8 -*-
"""生成课表解析测试用的 fixture 文件（xlsx / csv）。"""
from pathlib import Path

from openpyxl import Workbook

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
FIX.mkdir(parents=True, exist_ok=True)


def make_schedule_xlsx():
    wb = Workbook()
    ws = wb.active
    ws.title = "课表"
    ws.append(["节次", "星期一", "星期二", "星期三", "星期四", "星期五"])
    ws.append(["第1-2节", "高等数学\n张老师\n教A101", "", "大学英语\n李老师\n教B202", "", ""])
    ws.append(["第3-4节", "", "线性代数\n王老师\n教C303", "", "大学物理\n赵老师\n实验楼201", ""])
    ws.append(["第5-6节", "数据结构\n刘老师\n机房301", "", "", "", "体育\n陈老师\n操场"])
    ws.append(["第7-8节", "", "", "单片机原理\n周老师\n教D404", "", ""])
    out = FIX / "schedule.xlsx"
    wb.save(out)
    print("SAVED", out, out.stat().st_size, "bytes")


def make_merged_xlsx():
    """合并单元格 + 长课程名，模拟教务系统课表。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "本学期课表"
    ws.append(["时间", "周一", "周二"])
    ws.append(["1-2节", "习近平新时代中国特色社会主义思想概论", ""])
    ws.merge_cells("B2:C2")
    ws.append(["3-4节", "", "计算机网络\n孙老师\n教E505"])
    out = FIX / "schedule-merged.xlsx"
    wb.save(out)
    print("SAVED", out, out.stat().st_size, "bytes")


def make_gbk_csv():
    text = (
        "节次,星期一,星期二\n"
        "第1-2节,高等数学,大学英语\n"
        "第3-4节,,线性代数\n"
    )
    out = FIX / "schedule-gbk.csv"
    out.write_bytes(text.encode("gbk"))
    print("SAVED", out, out.stat().st_size, "bytes")


def make_format_xlsx():
    """模拟真实教务系统导出的课表格式：一格多门课、课程/节次/地点/教师/性质、汇总行。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet0"
    ws.append(
        [
            "2026-2027年第1学期",
            None,
            None,
            "计算机2301课表",
            None,
            "专业：计算机科学与技术B",
        ]
    )
    ws.append(["节次", None, "星期一", "星期二", "星期三", "星期四", "星期五"])
    ws.append(
        [
            "上午",
            "一",
            "高等数学/(1-2节)1-3周/本部 2-416/张三/必修/0\r\n"
            "线性代数/(1-2节)4-16周/本部 10-401/李四/选修/0",
            "大学英语/(1-2节)5-16周/本部 10-401/王五/必修/0",
            "",
        ]
    )
    ws.append(
        [
            "",
            "二",
            "计算机组成原理/(3-4节)1-4周/本部 12-西阶二/赵六/必修/0\r\n"
            "操作系统/(3-4节)5-16周/本部 2-425/钱七/必修/0",
            "",
            "数据结构/(3-4节)1-16周/本部 4-332/孙八/必修/0",
        ]
    )
    ws.append(
        [
            "其他课程：形势与政策Ⅴ★教师甲(共4周)/5-8周;   "
            "习近平新时代中国特色社会主义思想概论☆教师乙(共16周)/1-16周;",
            None,
        ]
    )
    ws.append(["注--内容顺序为：课程<>周次<>校区<>地点<>教师<>课程性质简称<>选课人数", None])
    out = FIX / "schedule-format.xlsx"
    wb.save(out)
    print("SAVED", out, out.stat().st_size, "bytes")


if __name__ == "__main__":
    make_schedule_xlsx()
    make_merged_xlsx()
    make_gbk_csv()
    make_format_xlsx()
