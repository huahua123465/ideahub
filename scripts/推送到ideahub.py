#!/usr/bin/env python3
"""
把本地跑出来的结果推送到 IdeaHub。

给技术1 / 技术2 用。设计前提是「在自己电脑上跑，没有服务器」：
  · 只用 Python 标准库，不用 pip install 任何东西
  · 网络不通、临时断网都不会丢数据 —— 失败的记录落到本地文件，下次跑自动补推
  · 重复推送是安全的，所以补推不用判断「上次推到哪了」

用法：
    export IDEAHUB_KEY=ih_tech2_你的密钥        # Windows: set IDEAHUB_KEY=...
    python3 推送到ideahub.py ping               # 先验证密钥通不通
    python3 推送到ideahub.py client 客户.csv     # 技术2：推客户和 AI 分析
    python3 推送到ideahub.py save 需求.csv       # 技术1：推需求 / 灵感 / 对标作品
    python3 推送到ideahub.py analysis matrix 结果.json [更多.json ...]
                                                # 技术1：把采集分析的 JSON 原样推成对标作品
    python3 推送到ideahub.py analysis persona 某个文件夹/
    python3 推送到ideahub.py retry              # 把之前失败的补推一遍

analysis 的第二个参数是进哪个板块：
    persona  真人作品的对标账号
    matrix   矩阵作品的对标账号
    live     真人直播的对标
    persona,matrix  同一个作品同时进两个板块（同一份 JSON 不会变成两条重复记录）
JSON 一个字都不用改，导出来是什么样就推什么样。

CSV 第一行是表头，列名就是接口字段名（见接入说明文档）。
带点的列名会被拼成嵌套对象：female.年龄 → {"female": {"年龄": ...}}
tags 列用顿号或逗号分隔多个标签。
"""
import csv, json, os, ssl, sys, time, urllib.error, urllib.request
from pathlib import Path

BASE = os.environ.get("IDEAHUB_URL", "https://xm.xingxingqule.com:9443")
KEY = os.environ.get("IDEAHUB_KEY", "")
# 失败的记录攒在这里。放在脚本旁边而不是临时目录 —— 临时目录会被系统清掉，
# 而这些是还没进 IdeaHub 的数据，丢了就真丢了。
FAILED = Path(__file__).with_name("推送失败待补.jsonl")

TIMEOUT = 20
RETRY = 3          # 单条最多重试 3 次，之后落盘等下次补推


def 发请求(路径, 数据):
    """发一个 POST，带重试。

    返回 (成功?, 结果或错误说明, 值不值得以后再试)。
    第三项很重要：网络问题以后会好，数据填错了重试一万次也一样 ——
    把它们混在一起补推，用户会永远看到一堆补不掉的失败记录。
    """
    req = urllib.request.Request(
        BASE + 路径,
        data=json.dumps(数据, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + KEY,
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    最后错误 = ""
    for 第几次 in range(RETRY):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return True, json.loads(r.read().decode("utf-8")), True
        except urllib.error.HTTPError as e:
            正文 = e.read().decode("utf-8", "replace")
            # 4xx 是数据本身有问题，重试多少次都一样，直接放弃
            if 400 <= e.code < 500:
                return False, f"HTTP {e.code} {正文}", False
            最后错误 = f"HTTP {e.code} {正文}"
        except Exception as e:                       # 断网、超时、DNS 失败
            最后错误 = f"{type(e).__name__}: {e}"
        # 退避重试：1 秒、2 秒。本地网络抖一下很常见，别一次失败就放弃
        if 第几次 < RETRY - 1:
            time.sleep(2 ** 第几次)
    return False, 最后错误, True


def 落盘(路径, 数据, 原因):
    """没推上去的存本地，下次 retry 补推。接口是幂等的，补推不会产生重复"""
    with FAILED.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"路径": 路径, "数据": 数据, "原因": 原因},
                           ensure_ascii=False) + "\n")


def 一行转对象(行):
    """CSV 的一行 → 接口要的 JSON。带点的列名拼成嵌套对象，tags 拆成数组"""
    out = {}
    for 列名, 值 in 行.items():
        if 列名 is None:
            continue
        列名 = 列名.strip()
        值 = (值 or "").strip()
        if not 列名 or not 值:
            continue
        if 列名 == "tags":
            out["tags"] = [t.strip() for t in 值.replace("、", ",").split(",") if t.strip()]
        elif "." in 列名:
            组, 子 = 列名.split(".", 1)
            out.setdefault(组, {})[子] = 值
        else:
            out[列名] = 值
    return out


def 推一批(路径, csv文件):
    if not Path(csv文件).exists():
        print(f"找不到文件：{csv文件}")
        return 1
    成功 = 新建 = 更新 = 待补 = 要改 = 0
    坏行 = []
    # utf-8-sig：Excel 导出的 CSV 开头有 BOM，不处理的话第一个列名会带一串乱码
    with open(csv文件, newline="", encoding="utf-8-sig") as f:
        for 序号, 行 in enumerate(csv.DictReader(f), 1):
            数据 = 一行转对象(行)
            if not 数据:
                continue
            ok, 结果, 可重试 = 发请求(路径, 数据)
            if ok:
                成功 += 1
                if 结果.get("created"):
                    新建 += 1
                else:
                    更新 += 1
                print(f"  第 {序号} 行 ✓ id={结果.get('id')} "
                      f"{'新建' if 结果.get('created') else '更新已有'}")
            elif 可重试:
                待补 += 1
                落盘(路径, 数据, 结果)
                print(f"  第 {序号} 行 ⟳ 没推上去（{结果}），已记下待补推")
            else:
                要改 += 1
                坏行.append((序号, 结果))
                print(f"  第 {序号} 行 ✗ 这条数据有问题：{结果}")

    print(f"\n完成：成功 {成功} 条（新建 {新建} / 更新 {更新}）")
    if 待补:
        print(f"网络原因没推上去 {待补} 条，已存到 {FAILED.name}；"
              f"网好了跑 `python3 {Path(__file__).name} retry` 补推")
    if 要改:
        # 这些不进补推队列：内容不改，推一万次还是同样的错
        print(f"数据本身有问题 {要改} 条，改完 CSV 再推一遍即可（重复推送不会产生副本）：")
        for 序号, 原因 in 坏行[:10]:
            print(f"    第 {序号} 行 — {原因}")
    return 0 if (待补 == 0 and 要改 == 0) else 2


def 推分析(板块, 路径们):
    """把技术1 导出的采集分析 JSON 原样推成对标作品。

    和 CSV 那条路不同：这里**不做任何字段映射** —— 整份 JSON 就是请求体。
    技术1 那边导出格式以后加字段，这个脚本不用改，IdeaHub 也不会丢数据。
    """
    文件们 = []
    for 一个 in 路径们:
        p = Path(一个)
        if p.is_dir():
            # 文件夹里的 .json 全推。技术1 是批量跑的，一次一个文件太慢
            文件们 += sorted(x for x in p.glob("*.json") if x.is_file())
        elif p.exists():
            文件们.append(p)
        else:
            print(f"找不到：{一个}")
    if not 文件们:
        print("没有要推的 JSON 文件")
        return 1

    路径 = f"/api/ingest/analysis?channel={板块}"
    成功 = 新建 = 更新 = 待补 = 要改 = 0
    for p in 文件们:
        try:
            数据 = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            # 读不出来的文件不进补推队列：内容不改，推一万次还是同样的错
            要改 += 1
            print(f"  {p.name} ✗ 不是合法的 JSON：{e}")
            continue
        if not isinstance(数据, dict):
            要改 += 1
            print(f"  {p.name} ✗ 顶层要是一个 JSON 对象，不是数组")
            continue

        ok, 结果, 可重试 = 发请求(路径, 数据)
        if ok:
            成功 += 1
            条目 = 结果.get("results") or [{"id": 结果.get("id"), "created": 结果.get("created")}]
            for 条 in 条目:
                if 条.get("created"):
                    新建 += 1
                else:
                    更新 += 1
            去处 = "、".join(f"{条.get('board')}#{条.get('id')}" for 条 in 条目)
            print(f"  {p.name} ✓ {去处}  {结果.get('title') or ''}")
        elif 可重试:
            待补 += 1
            落盘(路径, 数据, 结果)
            print(f"  {p.name} ⟳ 没推上去（{结果}），已记下待补推")
        else:
            要改 += 1
            print(f"  {p.name} ✗ 这份数据有问题：{结果}")

    print(f"\n完成：成功 {成功} 份（写入 {新建} 条新记录 / 更新 {更新} 条已有记录）")
    if 待补:
        print(f"网络原因没推上去 {待补} 份，已存到 {FAILED.name}；"
              f"网好了跑 `python3 {Path(__file__).name} retry` 补推")
    if 要改:
        print(f"数据本身有问题 {要改} 份，见上面每一行的说明")
    return 0 if (待补 == 0 and 要改 == 0) else 2


def 补推():
    if not FAILED.exists():
        print("没有待补推的记录")
        return 0
    行们 = [l for l in FAILED.read_text(encoding="utf-8").splitlines() if l.strip()]
    print(f"待补推 {len(行们)} 条")
    剩下 = []
    好 = 0
    for l in 行们:
        条 = json.loads(l)
        ok, 结果, 可重试 = 发请求(条["路径"], 条["数据"])
        if ok:
            好 += 1
            print(f"  ✓ id={结果.get('id')}")
        elif 可重试:
            剩下.append(l)
            print(f"  ⟳ 还是没通：{结果}")
        else:
            # 补推时才发现内容有问题（比如标签被管理员停用了）：
            # 留在队列里只会每次都失败，直接踢出来告诉用户
            print(f"  ✗ 这条数据有问题，已从队列移除：{结果}")
    # 补推成功的从文件里去掉，剩下的留着下次再试
    if 剩下:
        FAILED.write_text("\n".join(剩下) + "\n", encoding="utf-8")
    else:
        FAILED.unlink()
    print(f"\n补推成功 {好} 条，还剩 {len(剩下)} 条")
    return 0 if not 剩下 else 2


def 验证():
    req = urllib.request.Request(BASE + "/api/ingest/ping",
                                 headers={"Authorization": "Bearer " + KEY})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            d = json.loads(r.read().decode("utf-8"))
        print(f"通了。这把钥匙属于「{d['name']}」，权限：{', '.join(d['scopes'])}")
        return 0
    except urllib.error.HTTPError as e:
        print(f"没通：HTTP {e.code} {e.read().decode('utf-8','replace')}")
        print("401 = 密钥不对或已停用；403 = 这把钥匙没有对应权限")
        return 1
    except Exception as e:
        print(f"连不上 {BASE}：{type(e).__name__}: {e}")
        print("检查一下网络；如果公司网络封了 9443 端口，找 IdeaHub 管理员换个入口")
        return 1


def main():
    if not KEY:
        print("先设置密钥：export IDEAHUB_KEY=ih_xxx_你的密钥")
        print("Windows 命令行：set IDEAHUB_KEY=ih_xxx_你的密钥")
        return 1
    参数 = sys.argv[1:]
    if not 参数 or 参数[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    命令 = 参数[0]
    if 命令 == "ping":
        return 验证()
    if 命令 == "retry":
        return 补推()
    if 命令 == "client":
        if len(参数) < 2:
            print("用法：python3 推送到ideahub.py client 客户.csv")
            return 1
        return 推一批("/api/ingest/client", 参数[1])
    if 命令 == "save":
        if len(参数) < 2:
            print("用法：python3 推送到ideahub.py save 需求.csv")
            return 1
        return 推一批("/api/ingest/save", 参数[1])
    if 命令 == "analysis":
        if len(参数) < 3:
            print("用法：python3 推送到ideahub.py analysis persona|matrix|live 结果.json [更多.json ...]")
            print("     python3 推送到ideahub.py analysis matrix 某个文件夹/")
            return 1
        板块 = 参数[1]
        合法 = {"persona", "matrix", "live"}
        if not set(板块.split(",")) <= 合法:
            print(f"板块只能是 persona / matrix / live（可以用逗号同时给两个），收到的是「{板块}」")
            return 1
        return 推分析(板块, 参数[2:])
    print(f"不认识的命令：{命令}")
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
