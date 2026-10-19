# -*- coding: utf-8 -*-
"""梅花易数起卦脚本。依赖 lunar_python==1.4.8。

只有时间起卦用脚本完整起卦；报数、测字、后天观物等起卦计算简单，由人工计算，脚本只给干支。
用法（时间一律北京时间，--dt 为卦主求问时刻，省略则取当前时间）：
  python qigua.py time [--dt "2026-10-16 19:37"]      时间起卦：农历、干支、主互变卦、体用、生克、旺衰
  python qigua.py ganzhi [--dt "2026-10-16 19:37"]    其他起卦方式：只给农历与年月日时干支
"""
import argparse
import sys
from datetime import datetime

from lunar_python import Solar

sys.stdout.reconfigure(encoding="utf-8")

GAN = "甲乙丙丁戊己庚辛壬癸"
ZHI = "子丑寅卯辰巳午未申酉戌亥"
# 先天数 1-8；爻自下而上，1 阳 0 阴
TRIGRAMS = {
    1: ("乾", "天", "金", (1, 1, 1)),
    2: ("兑", "泽", "金", (1, 1, 0)),
    3: ("离", "火", "火", (1, 0, 1)),
    4: ("震", "雷", "木", (1, 0, 0)),
    5: ("巽", "风", "木", (0, 1, 1)),
    6: ("坎", "水", "水", (0, 1, 0)),
    7: ("艮", "山", "土", (0, 0, 1)),
    8: ("坤", "地", "土", (0, 0, 0)),
}
NAMES = {
    1: "乾为天 天泽履 天火同人 天雷无妄 天风姤 天水讼 天山遁 天地否",
    2: "泽天夬 兑为泽 泽火革 泽雷随 泽风大过 泽水困 泽山咸 泽地萃",
    3: "火天大有 火泽睽 离为火 火雷噬嗑 火风鼎 火水未济 火山旅 火地晋",
    4: "雷天大壮 雷泽归妹 雷火丰 震为雷 雷风恒 雷水解 雷山小过 雷地豫",
    5: "风天小畜 风泽中孚 风火家人 风雷益 巽为风 风水涣 风山渐 风地观",
    6: "水天需 水泽节 水火既济 水雷屯 水风井 坎为水 水山蹇 水地比",
    7: "山天大畜 山泽损 山火贲 山雷颐 山风蛊 山水蒙 艮为山 山地剥",
    8: "地天泰 地泽临 地火明夷 地雷复 地风升 地水师 地山谦 坤为地",
}
LINES_TO_NUM = {v[3]: k for k, v in TRIGRAMS.items()}
# 地支所属季节：当令五行
ZHI_WX = {"寅": "木", "卯": "木", "巳": "火", "午": "火", "申": "金", "酉": "金",
          "亥": "水", "子": "水", "辰": "土", "戌": "土", "丑": "土", "未": "土"}
SHENG = {"木": "火", "火": "土", "土": "金", "金": "水", "水": "木"}
KE = {"木": "土", "土": "水", "水": "火", "火": "金", "金": "木"}


def mod(n, m):
    r = n % m
    return r if r else m


def time_info(dt):
    lunar = Solar.fromYmdHms(dt.year, dt.month, dt.day, dt.hour, dt.minute, 0).getLunar()
    hour_idx = ((dt.hour + 1) // 2) % 12  # 0=子
    day_gz = lunar.getDayInGanZhi()  # 0 点才换日
    hour_gan = GAN[(GAN.index(day_gz[0]) % 5 * 2 + hour_idx) % 10]  # 时干按当天日干推
    return {
        "lunar_year_zhi": lunar.getYearZhi(),  # 按春节换年，起卦用
        "lunar_month": abs(lunar.getMonth()),  # 闰月按所闰之月
        "leap": lunar.getMonth() < 0,
        "lunar_day": lunar.getDay(),
        "hour_num": hour_idx + 1,
        "year_gz": lunar.getYearInGanZhiByLiChun(),
        "month_gz": lunar.getMonthInGanZhiExact(),
        "day_gz": day_gz,
        "hour_gz": hour_gan + ZHI[hour_idx],
    }


def wangshuai(wx, zhi):
    ling = ZHI_WX[zhi]
    if wx == ling:
        return "旺"
    if SHENG[ling] == wx:
        return "相"
    if SHENG[wx] == ling:
        return "休"
    if KE[wx] == ling:
        return "囚"
    return "死"


def relation(a, b):
    """a 对 b 的五行关系。"""
    wa, wb = TRIGRAMS[a][2], TRIGRAMS[b][2]
    if wa == wb:
        return "比和"
    if SHENG[wa] == wb:
        return "生"
    if KE[wa] == wb:
        return "克"
    if SHENG[wb] == wa:
        return "被生于"
    return "被克于"


def hexagram(up, down):
    return NAMES[up].split()[down - 1]


def tri_str(n):
    name, xiang, wx, _ = TRIGRAMS[n]
    return f"{name}（{xiang}，{wx}）"


def calendar_lines(info):
    leap = "闰" if info["leap"] else ""
    return [
        f"干支：{info['year_gz']}年 {info['month_gz']}月 {info['day_gz']}日 {info['hour_gz']}时",
        f"农历：{info['lunar_year_zhi']}年 {leap}{info['lunar_month']}月 {info['lunar_day']}日 "
        f"{ZHI[info['hour_num'] - 1]}时（起卦年数按春节、旺衰按节气）",
    ]


def build(up, down, moving, info, source):
    lines = list(TRIGRAMS[down][3] + TRIGRAMS[up][3])  # 初爻到上爻
    hu_down = LINES_TO_NUM[tuple(lines[1:4])]
    hu_up = LINES_TO_NUM[tuple(lines[2:5])]
    changed = lines[:]
    changed[moving - 1] ^= 1
    b_down = LINES_TO_NUM[tuple(changed[0:3])]
    b_up = LINES_TO_NUM[tuple(changed[3:6])]
    if moving <= 3:
        ti, yong, bian_yong = up, down, b_down
        ti_hu, yong_hu = hu_up, hu_down
    else:
        ti, yong, bian_yong = down, up, b_up
        ti_hu, yong_hu = hu_down, hu_up

    out = [f"起卦方式：{source}"] + calendar_lines(info)
    out.append(f"主卦：{hexagram(up, down)}（上{tri_str(up)} 下{tri_str(down)}），第{moving}爻动")
    out.append(f"互卦：{hexagram(hu_up, hu_down)}（上互{tri_str(hu_up)} 下互{tri_str(hu_down)}）")
    out.append(f"变卦：{hexagram(b_up, b_down)}（上{tri_str(b_up)} 下{tri_str(b_down)}）")
    out.append(f"体卦：{tri_str(ti)}；用卦：主卦{tri_str(yong)}、变卦{tri_str(bian_yong)}")
    out.append(f"体互：{tri_str(ti_hu)}（体这一侧）；用互：{tri_str(yong_hu)}（用这一侧）")
    out.append("生克（以体为主语）：" + "；".join(
        f"体{TRIGRAMS[ti][0]}{relation(ti, x)}{label}{TRIGRAMS[x][0]}"
        for label, x in (("用卦", yong), ("变卦", bian_yong), ("体互", ti_hu), ("用互", yong_hu))))
    out.append(f"用卦之间：主卦{TRIGRAMS[yong][0]}{relation(yong, bian_yong)}变卦{TRIGRAMS[bian_yong][0]}；"
               f"体互{TRIGRAMS[ti_hu][0]}{relation(ti_hu, yong_hu)}用互{TRIGRAMS[yong_hu][0]}")
    for label, zhi in (("月令", info["month_gz"][1]), ("日辰", info["day_gz"][1])):
        out.append(f"旺衰（{label}{zhi}）：" + "、".join(
            f"{TRIGRAMS[n][0]}{wangshuai(TRIGRAMS[n][2], zhi)}"
            for n in dict.fromkeys((ti, yong, bian_yong, ti_hu, yong_hu))))
    print("\n".join(out))


def main():
    p = argparse.ArgumentParser(description="梅花易数时间起卦 / 干支")
    p.add_argument("mode", choices=["time", "ganzhi"])
    p.add_argument("--dt", help='卦主求问时刻，北京时间，如 "2026-10-16 19:37"')
    a = p.parse_args()

    dt = datetime.strptime(a.dt, "%Y-%m-%d %H:%M") if a.dt else datetime.now()
    info = time_info(dt)

    if a.mode == "ganzhi":
        print("\n".join(calendar_lines(info)))
        return
    base = ZHI.index(info["lunar_year_zhi"]) + 1 + info["lunar_month"] + info["lunar_day"]
    up, down, mv = mod(base, 8), mod(base + info["hour_num"], 8), mod(base + info["hour_num"], 6)
    src = f"时间起卦（年{base - info['lunar_month'] - info['lunar_day']}+月{info['lunar_month']}+日{info['lunar_day']}+时{info['hour_num']}）"
    build(up, down, mv, info, src)


if __name__ == "__main__":
    main()
