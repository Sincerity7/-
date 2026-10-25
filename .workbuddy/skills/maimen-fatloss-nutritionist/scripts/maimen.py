#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
麦门减脂营养师 · 核心计算引擎

职责边界：所有营养数值、热量凑配、过敏原过滤都在本脚本内完成。
模型只负责"调脚本 + 转述结果"，不参与任何算术 —— 这是"禁止编造数据"的工程保证。

数据来源优先级：
  1. --data 显式路径
  2. 环境变量 MAIMEN_MENU
  3. 技能自带快照 assets/mcdonalds-menu.json
  4. 当前工作目录 src/data/mcdonalds-menu.json（工程源数据）

子命令：
  profile    仅算 BMR / TDEE 与建议热量档
  plans      按用户档案生成 3 套一日三餐方案 + 横向对比（默认 markdown）
  item       查询单个单品的完整营养与价格
  swap       为某个单品找可替换候选（同分类/同餐段、热量±10%、避开过敏原）
  stats      数据说明与字段覆盖率（演示时说明数据来源用）
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Windows 控制台默认 GBK，强制 UTF-8 以便中文与表格正常输出
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

SKILL_DIR = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------- 常量定义

ACTIVITY_LEVELS = {
    "sedentary": ("久坐（基本不运动）", 1.2),
    "light": ("轻度活动（每周运动1-3天）", 1.375),
    "moderate": ("中度活动（每周运动3-5天）", 1.55),
    "intense": ("重度活动（每周运动6-7天）", 1.725),
}
ACTIVITY_ALIAS = {
    "久坐": "sedentary", "轻度": "light", "中度": "moderate", "重度": "intense",
    "1.2": "sedentary", "1.375": "light", "1.55": "moderate", "1.725": "intense",
}

# 三餐配额：早 30% / 午 40% / 晚 30%，单餐允许 ±15%
MEAL_QUOTAS = [("breakfast", "早餐", 0.30), ("lunch", "午餐", 0.40), ("dinner", "晚餐", 0.30)]
MEAL_FLOAT = 0.15
TOTAL_FLOAT = 0.05          # 整套总热量必须落在目标 ±5%
COMBOS_PER_STAPLE = 12      # 每个主食谱保留的配菜组合上限（剪枝）

SIDE_CATEGORIES = ["小食", "饮品", "麦咖啡", "甜品"]
DRINK_CATEGORIES = {"饮品", "麦咖啡"}   # 一餐最多一份饮品
KIDS_CATEGORY = "开心乐园餐"

STRATEGIES = [
    ("lowcal", "方案A · 控卡优先", "总热量贴近目标 95% 下限，同等条件下钠最低"),
    ("value", "方案B · 性价比优先", "每 100kcal 蛋白质最高（官网未公开售价，以蛋白/热量比为代理指标）"),
    ("satiety", "方案C · 饱腹感优先", "蛋白质+脂肪克数最高（总克重代理，更抗饿）"),
]

# ---------------------------------------------------------------- 数据访问


def load_menu(path=None):
    """按优先级定位并解析菜单快照，返回 (data, 实际读取路径)。"""
    candidates = []
    if path:
        candidates.append(Path(path))
    if os.environ.get("MAIMEN_MENU"):
        candidates.append(Path(os.environ["MAIMEN_MENU"]))
    candidates.append(SKILL_DIR / "assets" / "mcdonalds-menu.json")
    candidates.append(Path.cwd() / "src" / "data" / "mcdonalds-menu.json")

    for cand in candidates:
        if cand and cand.is_file():
            with cand.open(encoding="utf-8") as f:
                return json.load(f), cand
    raise SystemExit(
        "找不到菜单数据。请用 --data 指定，或确认 "
        "src/data/mcdonalds-menu.json 存在。"
    )


def filter_safe(items, allergens=(), keywords=(), avoid=()):
    """
    忌口过滤：
      - allergens 与单品 allergens 数组有交集 → 剔除；
      - keywords / avoid 命中餐品名称子串 → 剔除；
      - allergens 为 None 的单品保留，打上 allergenUnknown 标记（界面须提示自行确认）。
    """
    ua = {str(a).strip() for a in allergens if str(a).strip()}
    kws = [str(k).strip() for k in keywords if str(k).strip()]
    avs = [str(a).strip() for a in avoid if str(a).strip()]

    out = []
    for raw in items:
        al = raw.get("allergens")
        if isinstance(al, list) and ua and any(str(a).strip() in ua for a in al):
            continue
        name = str(raw.get("name") or "")
        if any(k in name for k in kws):
            continue
        if any(a in name for a in avs):
            continue
        item = dict(raw)
        if al is None:
            item["allergenUnknown"] = True
        out.append(item)
    return out


# ---------------------------------------------------------------- 代谢计算


def calc_bmr(gender, height_cm, weight_kg, age=30):
    """Mifflin-St Jeor 基础代谢率（kcal/天）。"""
    base = 10 * float(weight_kg) + 6.25 * float(height_cm) - 5 * float(age)
    is_male = str(gender).lower() in ("male", "m", "男", "男性")
    return base + (5 if is_male else -161)


def resolve_activity(activity):
    """解析活动档位，返回 (中文标签, 系数)。无法识别时回退久坐。"""
    if activity is None:
        return ACTIVITY_LEVELS["sedentary"]
    key = str(activity).strip()
    if key in ACTIVITY_LEVELS:
        return ACTIVITY_LEVELS[key]
    if key in ACTIVITY_ALIAS:
        return ACTIVITY_LEVELS[ACTIVITY_ALIAS[key]]
    try:  # 直接传数值系数
        factor = float(key)
        for label, f in ACTIVITY_LEVELS.values():
            if abs(f - factor) < 1e-6:
                return label, f
        return f"自定义系数 {factor}", factor
    except ValueError:
        return ACTIVITY_LEVELS["sedentary"]


def calc_tdee(gender, height_cm, weight_kg, activity, age=30):
    label, factor = resolve_activity(activity)
    bmr = calc_bmr(gender, height_cm, weight_kg, age)
    return round(bmr), round(bmr * factor), label, factor


# ---------------------------------------------------------------- 套餐生成


def _is_breakfast_staple(name):
    n = str(name or "")
    return ("堡" in n) or ("卷" in n) or ("麦满分" in n)


def _build_meal_candidates(staples, side_pool, lo, hi):
    """
    为一餐构建候选：主食 + 0~2 个配菜，热量落在 [lo, hi]。
    每个主食按四维度（蛋白密度 / 低钠 / 饱腹 / 贴近配额中心）各取前 3 去重截断。
    """
    out = []
    for staple in staples:
        combos = []

        def push(sides):
            # 一餐里不出现两份饮品（避免"冰美式+热美式"这种凑数搭配）
            if len(sides) == 2 and all(s.get("category") in DRINK_CATEGORIES for s in sides):
                return
            cal = staple.get("calories") or 0
            protein = staple.get("protein") or 0
            carbs = staple.get("carbs") or 0
            fat = staple.get("fat") or 0
            sodium = staple.get("sodium") or 0
            for s in sides:
                cal += s.get("calories") or 0
                protein += s.get("protein") or 0
                carbs += s.get("carbs") or 0
                fat += s.get("fat") or 0
                sodium += s.get("sodium") or 0
            if cal < lo or cal > hi:
                return
            items = [staple, *sides]
            combos.append({
                "items": items,
                # 预存 id 集合，用于保证同一天内不重复出现同一单品
                "ids": frozenset(it.get("id") for it in items),
                "calories": cal, "protein": protein,
                "carbs": carbs, "fat": fat, "sodium": sodium,
            })

        push([])
        n = len(side_pool)
        for i in range(n):
            push([side_pool[i]])
            for j in range(i + 1, n):
                push([side_pool[i], side_pool[j]])
        if not combos:
            continue

        center = (lo + hi) / 2
        picks = []
        picks += sorted(combos, key=lambda c: c["protein"] / c["calories"], reverse=True)[:3]
        picks += sorted(combos, key=lambda c: c["sodium"])[:3]
        picks += sorted(combos, key=lambda c: c["protein"] + c["fat"], reverse=True)[:3]
        picks += sorted(combos, key=lambda c: abs(c["calories"] - center))[:3]

        seen = set()
        for c in picks:
            key = "|".join(it.get("id", "") for it in c["items"])
            if key in seen:
                continue
            seen.add(key)
            out.append(c)
            if len(seen) >= COMBOS_PER_STAPLE:
                break
    return out


def _sum_plan(meals):
    """整套汇总。价格：任一单品未公开则整套标"未公开"（不臆造总价）。"""
    totals = {"calories": 0, "protein": 0, "carbs": 0, "fat": 0, "sodium": 0}
    price_sum = 0.0
    price_known = True
    count = 0
    for meal in meals:
        for it in meal["items"]:
            count += 1
            for k in totals:
                totals[k] += it.get(k) or 0
            p = it.get("price")
            if p is None:
                price_known = False
            else:
                price_sum += float(p)
    totals["count"] = count
    totals["price"] = round(price_sum, 1) if price_known else None
    return totals


def _blocking_allergens(items, allergens, keywords, avoid, predicate):
    """
    找出"单独去掉就能恢复可用餐品"的过敏原 —— 用于无解时指出到底是谁卡住了脖子。
    返回 [(过敏原, 恢复后的单品数)]。
    """
    out = []
    for a in allergens:
        rest = [x for x in allergens if x != a]
        pool = [
            it for it in filter_safe(items, rest, keywords, avoid)
            if isinstance(it.get("calories"), (int, float)) and predicate(it)
        ]
        if pool:
            out.append((a, len(pool)))
    return out


def generate_plans(items, target_calories, allergens=(), keywords=(), avoid=()):
    """
    生成三套策略各异的一日三餐方案。
    返回 {"plans": [...], "error": str|None}；无解时绝不输出超标方案。
    """
    if not items or not target_calories or target_calories <= 0:
        return {"plans": [], "error": "缺少可用餐品或每日目标热量无效"}

    usable = [
        it for it in filter_safe(items, allergens, keywords, avoid)
        if isinstance(it.get("calories"), (int, float)) and it.get("category") != KIDS_CATEGORY
    ]

    breakfast_pool = [
        it for it in usable
        if it.get("mealPeriod") == "breakfast" and it.get("category") == "早餐"
    ]
    breakfast_staples = [it for it in breakfast_pool if _is_breakfast_staple(it.get("name"))]
    # 降级：麦当劳的堡/卷/麦满分几乎全部含麸质，麸质过敏时早餐无主食可选，
    # 此时退到粥类/小食（如"雪菜脆笋鸡肉粥""德式图林根香肠"），而不是直接报无解。
    degraded_breakfast = False
    if not breakfast_staples and breakfast_pool:
        breakfast_staples = breakfast_pool
        degraded_breakfast = True
    burger_staples = [
        it for it in usable
        if it.get("mealPeriod") == "allDay" and it.get("category") == "汉堡和卷"
    ]
    side_pool = [
        it for it in usable
        if it.get("mealPeriod") == "allDay" and it.get("category") in SIDE_CATEGORIES
    ]

    if not breakfast_staples:
        blockers = _blocking_allergens(
            items, allergens, keywords, avoid,
            lambda it: it.get("mealPeriod") == "breakfast" and it.get("category") == "早餐",
        )
        hint = "、".join(f"「{a}」" for a, _n in blockers) if blockers else "你的忌口组合"
        return {"plans": [], "error": f"早餐被{hint}全部排除，无法组成早餐。建议放宽该过敏原，或早餐改由门店外解决"}
    if not burger_staples:
        blockers = _blocking_allergens(
            items, allergens, keywords, avoid,
            lambda it: it.get("mealPeriod") == "allDay" and it.get("category") == "汉堡和卷",
        )
        hint = "、".join(f"「{a}」" for a, _n in blockers) if blockers else "你的忌口组合"
        return {
            "plans": [],
            "error": f"午/晚餐主食被{hint}全部排除（麦当劳汉堡与卷的面包胚普遍含麸质/牛奶），"
                     f"在麦当劳内已凑不出合规三餐。建议：放宽该过敏原，或只在麦门解决其中 1–2 餐",
        }

    windows = []
    for _period, _label, quota in MEAL_QUOTAS:
        q = target_calories * quota
        windows.append((q * (1 - MEAL_FLOAT), q * (1 + MEAL_FLOAT)))

    pools = [
        (breakfast_staples, side_pool),
        (burger_staples, side_pool),
        (burger_staples, side_pool),
    ]
    meal_cands = [
        _build_meal_candidates(pools[i][0], pools[i][1], windows[i][0], windows[i][1])
        for i in range(3)
    ]
    if any(len(c) == 0 for c in meal_cands):
        return {
            "plans": [],
            "error": "当前忌口条件下无法凑出达标套餐，建议放宽过敏原/忌口或提高每日热量上限",
        }

    total_min = target_calories * (1 - TOTAL_FLOAT)
    total_max = target_calories * (1 + TOTAL_FLOAT)
    dinner_sorted = sorted(meal_cands[2], key=lambda c: c["calories"])

    best = {"lowcal": None, "value": None, "satiety": None}

    def better_than(strategy, cand, cur):
        if cur is None:
            return True
        if strategy == "lowcal":
            gap = abs(cand["calories"] - target_calories * 0.95)
            cur_gap = abs(cur["calories"] - target_calories * 0.95)
            if gap != cur_gap:
                return gap < cur_gap
        elif strategy == "value":
            dens = cand["protein"] / cand["calories"]
            cur_dens = cur["protein"] / cur["calories"]
            if dens != cur_dens:
                return dens > cur_dens
        else:
            sat = cand["protein"] + cand["fat"]
            cur_sat = cur["protein"] + cur["fat"]
            if sat != cur_sat:
                return sat > cur_sat
        # 同分裁判：高蛋白优先，其次低钠
        if cand["protein"] != cur["protein"]:
            return cand["protein"] > cur["protein"]
        return cand["sodium"] < cur["sodium"]

    def merge(b, l, d):
        return {
            "cands": (b, l, d),
            "ids": b["ids"] | l["ids"] | d["ids"],
            "calories": b["calories"] + l["calories"] + d["calories"],
            "protein": b["protein"] + l["protein"] + d["protein"],
            "carbs": b["carbs"] + l["carbs"] + d["carbs"],
            "fat": b["fat"] + l["fat"] + d["fat"],
            "sodium": b["sodium"] + l["sodium"] + d["sodium"],
        }

    for b in meal_cands[0]:
        for l in meal_cands[1]:
            # 同一天内同一单品只出现一次，避免"早中晚各一份鸡翅"这种不真实搭配
            if b["ids"] & l["ids"]:
                continue
            used = b["ids"] | l["ids"]
            sum2 = b["calories"] + l["calories"]
            d_lo = total_min - sum2
            d_hi = total_max - sum2
            if d_hi < dinner_sorted[0]["calories"]:
                continue
            if d_lo > dinner_sorted[-1]["calories"]:
                continue
            for d in dinner_sorted:
                if d["calories"] < d_lo:
                    continue
                if d["calories"] > d_hi:
                    break
                if d["ids"] & used:
                    continue
                merged = merge(b, l, d)
                if total_min <= merged["calories"] <= total_max:
                    for s in ("lowcal", "value", "satiety"):
                        if better_than(s, merged, best[s]):
                            best[s] = merged

    if not all(best[s] for s in ("lowcal", "value", "satiety")):
        return {
            "plans": [],
            "error": "当前忌口条件下无法凑出达标套餐，建议放宽过敏原/忌口或提高每日热量上限",
        }

    plans = []
    for s, label, desc in STRATEGIES:
        meals = []
        for i, cand in enumerate(best[s]["cands"]):
            meals.append({
                "period": MEAL_QUOTAS[i][0],
                "periodLabel": MEAL_QUOTAS[i][1],
                "items": cand["items"],
            })
        plans.append({
            "strategy": s,
            "label": label,
            "desc": desc,
            "meals": meals,
            "totals": _sum_plan(meals),
        })
    return {"plans": plans, "error": None, "degradedBreakfast": degraded_breakfast}


# ---------------------------------------------------------------- Markdown 渲染


def _num(v, unit="", digits=0):
    if v is None:
        return "未公开"
    if digits:
        return f"{round(float(v), digits)}{unit}"
    return f"{round(float(v))}{unit}"


def _price(v):
    return "未公开" if v is None else f"¥{v}"


def render_plan_md(plan, target_calories=None):
    """单套方案：清单表格 + 分割线 + 汇总。"""
    lines = [f"### {plan['label']}", f"> {plan['desc']}", ""]
    lines.append("| 餐段 | 单品 | 规格 | 价格 | 热量 | 蛋白质 | 碳水 | 脂肪 | 钠 |")
    lines.append("|---|---|---|---|---:|---:|---:|---:|---:|")
    unknown_note = False
    inferred_note = False
    for meal in plan["meals"]:
        for it in meal["items"]:
            if it.get("allergenUnknown"):
                unknown_note = True
            if isinstance(it.get("allergens"), list) and it.get("allergenBasis"):
                inferred_note = True
            lines.append(
                f"| {meal['periodLabel']} | {it['name']} | {it.get('unit') or '-'} "
                f"| {_price(it.get('price'))} | {_num(it.get('calories'),' kcal')} "
                f"| {_num(it.get('protein'),' g',1)} | {_num(it.get('carbs'),' g',1)} "
                f"| {_num(it.get('fat'),' g',1)} | {_num(it.get('sodium'),' mg')} |"
            )

    t = plan["totals"]
    lines += ["", "---", ""]
    head = f"**整套合计**｜热量 **{round(t['calories'])} kcal**"
    if target_calories:
        dev = (t["calories"] - target_calories) / target_calories * 100
        head += f"（目标 {target_calories} kcal，偏差 {dev:+.1f}%）"
    head += f"｜蛋白质 **{round(t['protein'],1)} g**｜碳水 {round(t['carbs'],1)} g｜脂肪 {round(t['fat'],1)} g｜钠 {round(t['sodium'])} mg｜共 {t['count']} 件"
    lines.append(head)

    # 三大营养素供能比
    p_kcal = t["protein"] * 4
    c_kcal = t["carbs"] * 4
    f_kcal = t["fat"] * 9
    total_kcal = p_kcal + c_kcal + f_kcal
    if total_kcal > 0:
        lines.append(
            f"供能比（蛋白/碳水/脂肪）：{p_kcal/total_kcal*100:.0f}% / "
            f"{c_kcal/total_kcal*100:.0f}% / {f_kcal/total_kcal*100:.0f}%　"
            f"整套总价：{_price(t['price'])}"
        )
    if inferred_note:
        lines.append("")
        lines.append("> ⚠️ 标注单品含过敏原推断数据（依据餐品名称与配方常识），**非官方声明**，实际以门店为准。")
    if unknown_note:
        lines.append("> ⚠️ 标注单品官网未披露过敏原，**过敏原未知，请自行确认**。")
    return "\n".join(lines)


def render_comparison_md(plans, target_calories=None):
    """三套横向对比表。"""
    lines = ["## 方案横向对比", ""]
    lines.append("| 维度 | " + " | ".join(p["label"] for p in plans) + " |")
    lines.append("|---|" + "---:|" * len(plans))

    rows = [
        ("总热量", lambda t: _num(t["calories"], " kcal")),
        ("达成目标", lambda t: (
            f"{(t['calories']-target_calories)/target_calories*100:+.1f}%"
            if target_calories else "—")),
        ("蛋白质", lambda t: _num(t["protein"], " g", 1)),
        ("蛋白密度", lambda t: f"{t['protein']/t['calories']*100:.1f} g/100kcal"),
        ("碳水", lambda t: _num(t["carbs"], " g", 1)),
        ("脂肪", lambda t: _num(t["fat"], " g", 1)),
        ("钠", lambda t: _num(t["sodium"], " mg")),
        ("总价", lambda t: _price(t["price"])),
        ("件数", lambda t: f"{t['count']} 件"),
    ]
    for name, fn in rows:
        lines.append(f"| {name} | " + " | ".join(fn(p["totals"]) for p in plans) + " |")

    lines += ["", "**怎么选**："]
    for p in plans:
        lines.append(f"- **{p['label']}** —— {p['desc']}")
    return "\n".join(lines)


# ---------------------------------------------------------------- 子命令


def cmd_profile(args):
    bmr, tdee, act_label, factor = calc_tdee(
        args.sex, args.height, args.weight, args.activity, args.age
    )
    if args.json:
        print(json.dumps({
            "bmr": bmr, "tdee": tdee,
            "activity": act_label, "activityFactor": factor,
            "suggestFloors": {
                "温和减脂(-15%)": round(tdee * 0.85),
                "标准减脂(-20%)": round(tdee * 0.80),
                "激进减脂(-25%)": round(tdee * 0.75),
            },
        }, ensure_ascii=False, indent=2))
        return

    print(f"**基础代谢 BMR**：{bmr} kcal/天")
    print(f"**日常消耗 TDEE**：{tdee} kcal/天（{act_label}，系数 {factor}）")
    print()
    print("| 减脂强度 | 每日目标热量 | 说明 |")
    print("|---|---:|---|")
    print(f"| 温和 -15% | {round(tdee*0.85)} kcal | 掉秤慢但好坚持，适合新手 |")
    print(f"| 标准 -20% | {round(tdee*0.80)} kcal | 推荐区间，兼顾速度与可持续 |")
    print(f"| 激进 -25% | {round(tdee*0.75)} kcal | 掉秤快，易饿易破功 |")
    print()
    print("> 女性每日不建议低于 1200 kcal、男性不低于 1500 kcal；低于此线请先咨询医生。")


def _parse_list(value):
    if not value:
        return []
    return [x.strip() for x in str(value).replace("，", ",").replace("、", ",").split(",") if x.strip()]


def cmd_plans(args):
    data, path = load_menu(args.data)
    items = data.get("items") or []
    target = args.target
    if not target:
        if args.sex and args.height and args.weight:
            _bmr, tdee, _l, _f = calc_tdee(args.sex, args.height, args.weight, args.activity, args.age)
            target = round(tdee * 0.80)
            print(f"> 未指定目标热量，按 TDEE {tdee} kcal × 80%（标准减脂）推算为 **{target} kcal**\n")
        else:
            raise SystemExit("缺少 --target；或同时提供 --sex/--height/--weight 以自动推算")
    target = int(round(target))

    result = generate_plans(
        items, target,
        allergens=_parse_list(args.allergens),
        keywords=_parse_list(args.keywords),
        avoid=_parse_list(args.avoid),
    )

    if args.json:
        print(json.dumps({**result, "targetCalories": target, "dataSource": str(path)},
                         ensure_ascii=False, indent=2))
        return

    print(f"## 麦门减脂一日三餐 · 目标 {target} kcal/天\n")
    cond = []
    if _parse_list(args.allergens):
        cond.append(f"忌过敏原：{'、'.join(_parse_list(args.allergens))}")
    if _parse_list(args.keywords):
        cond.append(f"忌口：{'、'.join(_parse_list(args.keywords))}")
    if _parse_list(args.avoid):
        cond.append(f"已排除：{'、'.join(_parse_list(args.avoid))}")
    if cond:
        print("**筛选条件**：" + "｜".join(cond) + "\n")

    if result["error"]:
        print(f"❌ {result['error']}")
        return

    if result.get("degradedBreakfast"):
        print("> ⚠️ 你的忌口把麦当劳早餐的堡/卷/麦满分全部排除了（它们基本都含麸质），"
              "早餐已降级为粥类/小食组合，蛋白质会偏低。\n")

    for plan in result["plans"]:
        print(render_plan_md(plan, target))
        print()
    print(render_comparison_md(result["plans"], target))
    meta = data.get("meta") or {}
    print()
    print(f"> 数据来源：{meta.get('source', '麦当劳中国官网')}（快照 {meta.get('fetchedAt', '-')}）。"
          f"热量按官网 kJ 换算；**价格与过敏原官网公开页未披露**，价格显示「未公开」，过敏原为推断值。")


def _find_item(items, name):
    name = str(name).strip()
    exact = [i for i in items if i.get("name") == name]
    if exact:
        return exact
    return [i for i in items if name in str(i.get("name") or "")]


def cmd_item(args):
    data, path = load_menu(args.data)
    hits = _find_item(data.get("items") or [], args.name)
    if not hits:
        print(f"未找到匹配「{args.name}」的单品。")
        return

    safe_ids = {i.get("id") for i in filter_safe(hits, _parse_list(args.allergens))}
    if args.json:
        print(json.dumps([{**h, "allergenSafe": h.get("id") in safe_ids} for h in hits],
                         ensure_ascii=False, indent=2))
        return

    print(f"## 单品营养查询 ·「{args.name}」\n")
    print("| 单品 | 分类 | 餐段 | 规格 | 价格 | 热量 | 蛋白质 | 碳水 | 脂肪 | 钠 | 过敏原 |")
    print("|---|---|---|---|---|---:|---:|---:|---:|---:|---|")
    for h in hits:
        al = h.get("allergens")
        al_text = "未知（自行确认）" if al is None else "、".join(al)
        period = "早餐" if h.get("mealPeriod") == "breakfast" else "全天"
        print(
            f"| {h['name']} | {h.get('category','-')} | {period} | {h.get('unit') or '-'} "
            f"| {_price(h.get('price'))} | {_num(h.get('calories'),' kcal')} "
            f"| {_num(h.get('protein'),' g',1)} | {_num(h.get('carbs'),' g',1)} "
            f"| {_num(h.get('fat'),' g',1)} | {_num(h.get('sodium'),' mg')} | {al_text} |"
        )
    for h in hits:
        if h.get("allergenBasis"):
            print(f"\n> 「{h['name']}」过敏原依据：{h['allergenBasis']}（推断，非官方声明）")

    if args.allergens:
        for h in hits:
            if h.get("id") not in safe_ids:
                print(f"\n❌ 「{h['name']}」命中你的忌口过敏原（{'、'.join(_parse_list(args.allergens))}），不建议选用。")


def cmd_swap(args):
    data, path = load_menu(args.data)
    items = data.get("items") or []
    hits = _find_item(items, args.item)
    if not hits:
        print(f"未找到匹配「{args.item}」的单品。")
        return
    target = hits[0]
    base_cal = target.get("calories") or 0
    if not base_cal:
        print(f"「{target['name']}」缺少热量数据，无法计算替换区间。")
        return

    lo = base_cal * (1 - args.tolerance / 100)
    hi = base_cal * (1 + args.tolerance / 100)
    pool = filter_safe(items, _parse_list(args.allergens), _parse_list(args.keywords),
                       avoid=[target.get("name")])
    cands = [
        it for it in pool
        if it.get("category") == target.get("category")
        and it.get("mealPeriod") == target.get("mealPeriod")
        and isinstance(it.get("calories"), (int, float))
        and lo <= it["calories"] <= hi
    ]
    cands.sort(key=lambda x: (x.get("protein") or 0) / x["calories"], reverse=True)
    cands = cands[:args.limit]

    if args.json:
        print(json.dumps({"original": target, "candidates": cands}, ensure_ascii=False, indent=2))
        return

    print(f"## 替换建议 ·「{target['name']}」\n")
    print(f"原单品：{target['name']}（{round(base_cal)} kcal，{target.get('category')}，"
          f"蛋白质 {round(target.get('protein') or 0, 1)} g）")
    print(f"候选区间：同分类同餐段、热量 {round(lo)}–{round(hi)} kcal（±{args.tolerance}%）、不含你的过敏原\n")
    if not cands:
        print("❌ 该区间内没有合规候选。建议放宽 ±10% 到 ±15%，或直接换一餐主食。")
        return

    print("| 候选单品 | 规格 | 价格 | 热量 | 热量差 | 蛋白质 | 钠 | 过敏原 |")
    print("|---|---|---|---:|---:|---:|---:|---|")
    for c in cands:
        al = c.get("allergens")
        al_text = "未知" if al is None else ("、".join(al) if al else "无")
        diff = (c["calories"] - base_cal) / base_cal * 100
        print(
            f"| {c['name']} | {c.get('unit') or '-'} | {_price(c.get('price'))} "
            f"| {round(c['calories'])} kcal | {diff:+.1f}% "
            f"| {_num(c.get('protein'),' g',1)} | {_num(c.get('sodium'),' mg')} | {al_text} |"
        )
    print("\n> 换完后整套总热量会变，建议把不喜欢的单品写进 `--avoid` 重新生成三套方案，"
          "由脚本重新保证 ±5% 达标。")


def cmd_stats(args):
    data, path = load_menu(args.data)
    items = data.get("items") or []
    meta = data.get("meta") or {}
    n = len(items)
    price_known = sum(1 for i in items if i.get("price") is not None)
    al_known = sum(1 for i in items if isinstance(i.get("allergens"), list))
    nutrition = sum(1 for i in items if i.get("calories") is not None)

    if args.json:
        print(json.dumps({
            "path": str(path), "meta": meta, "total": n,
            "priceCoverage": f"{price_known}/{n}",
            "allergenCoverage": f"{al_known}/{n}",
            "nutritionCoverage": f"{nutrition}/{n}",
        }, ensure_ascii=False, indent=2))
        return

    print("## 数据说明\n")
    print(f"- 数据文件：`{path}`")
    print(f"- 来源：{meta.get('source','-')}　快照时间：{meta.get('fetchedAt','-')}")
    print(f"- 单品总数：**{n}**　营养字段覆盖：{nutrition}/{n}　价格覆盖：{price_known}/{n}　过敏原覆盖：{al_known}/{n}")
    print()
    from collections import Counter
    cats = Counter(i.get("category") for i in items)
    periods = Counter(i.get("mealPeriod") for i in items)
    print("| 分类 | 单品数 |")
    print("|---|---:|")
    for k, v in cats.most_common():
        print(f"| {k} | {v} |")
    print()
    print(f"餐段分布：早餐 {periods.get('breakfast',0)} 个 / 全天 {periods.get('allDay',0)} 个")
    print()
    print("**口径说明**")
    print("- 热量：官网以 kJ 标注，按 1 kcal = 4.184 kJ 换算取整。")
    print("- 价格：官网公开页不披露（仅 App/小程序可见），故为空并显示「未公开」，**不做任何估算**。")
    print("- 过敏原：基于餐品名称关键词与配方常识推断，非官方声明；未能推断的标为未知。")


# ---------------------------------------------------------------- 入口


def main():
    parser = argparse.ArgumentParser(
        description="麦门减脂营养师 · 用真实麦当劳营养数据生成减脂一日三餐",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--data", help="菜单数据 JSON 路径（默认用技能内置快照）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add_profile_args(p):
        p.add_argument("--sex", choices=["男", "女", "male", "female"], help="性别")
        p.add_argument("--height", type=float, help="身高 cm")
        p.add_argument("--weight", type=float, help="体重 kg")
        p.add_argument("--age", type=float, default=30, help="年龄（默认 30）")
        p.add_argument("--activity", default="sedentary",
                       help="活动量：sedentary/light/moderate/intense 或 1.2~1.725")
        p.add_argument("--json", action="store_true", help="输出 JSON 而非 markdown")

    p_profile = sub.add_parser("profile", help="计算 BMR / TDEE 与建议热量档")
    add_profile_args(p_profile)
    p_profile.set_defaults(func=cmd_profile)

    p_plans = sub.add_parser("plans", help="生成 3 套一日三餐方案 + 横向对比")
    add_profile_args(p_plans)
    p_plans.add_argument("--target", type=float, help="每日目标热量 kcal（不给则按 TDEE×80% 推算）")
    p_plans.add_argument("--allergens", help="过敏原，逗号分隔，如：牛奶,麸质")
    p_plans.add_argument("--keywords", help="自定义忌口关键词，匹配餐品名称，如：辣,咖啡")
    p_plans.add_argument("--avoid", help="排除指定单品（不喜欢/已吃腻），逗号分隔")
    p_plans.set_defaults(func=cmd_plans)

    p_item = sub.add_parser("item", help="查询单品营养与价格")
    p_item.add_argument("--name", required=True, help="单品名称或关键词")
    p_item.add_argument("--allergens", help="用户过敏原，用于判断该单品是否可用")
    p_item.add_argument("--json", action="store_true")
    p_item.set_defaults(func=cmd_item)

    p_swap = sub.add_parser("swap", help="为单品找合规替换候选")
    p_swap.add_argument("--item", required=True, help="要替换掉的单品名")
    p_swap.add_argument("--allergens", help="用户过敏原，逗号分隔")
    p_swap.add_argument("--keywords", help="自定义忌口关键词")
    p_swap.add_argument("--tolerance", type=float, default=10, help="热量容差百分比，默认 10")
    p_swap.add_argument("--limit", type=int, default=8, help="最多返回候选数")
    p_swap.add_argument("--json", action="store_true")
    p_swap.set_defaults(func=cmd_swap)

    p_stats = sub.add_parser("stats", help="查看数据来源与字段覆盖率")
    p_stats.add_argument("--json", action="store_true")
    p_stats.set_defaults(func=cmd_stats)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
