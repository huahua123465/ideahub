#!/usr/bin/env python3
"""
给样式表里写死的颜色补深色值：把 `#fff` 改成 `light-dark(#fff, <深色值>)`。

2026-09-24 做深色模式时一次性跑过（之后样式表里新写的颜色要自己写成 light-dark(浅, 深)，
test:ui-polish:ui 会拦住裸色值）。脚本留着是为了说明深色值是怎么算出来的，也方便以后批量补。

  python3 scripts/dark-colors.py            # 改写 web/*.css
  python3 scripts/dark-colors.py --dry      # 只统计，不写文件

规则（在 OKLCH 里换算，保持色相）：
- 浅色值原样保留为 light-dark() 的第一个参数，所以浅色模式一个像素都不变
- 按属性分用途：
  文字（color / fill / stroke …）   → 一律提亮到 0.78~0.93；纯白字（彩色按钮上的）保持白色
  背景                              → 近白的底 / 浅色淡彩 → 深色面（0.17~0.25），淡彩保留色相；
                                      饱和的彩色底（按钮、徽标）保持原亮度，白字照样看得清；
                                      半透明的「压暗」蒙层 → 反过来变成「提亮」蒙层
  边框 / 描边                        → 浅灰线变深灰线；半透明线反相
  阴影                              → 仍是暗色，只把不透明度加大（深底上阴影要重一点才看得见）
  自定义属性（--xxx）                → 名字带 bg / pale / soft / surface / line 的按背景算，其余按文字算
- 不处理：:root 和 soft 主题根上的调色板变量（手工定的深色值）、遮罩（mask）里只起透明度作用的颜色、
  Word / PDF 预览的「纸面」（那几个容器声明了 color-scheme:light，纸面保持白纸黑字）
"""
import math, re, sys

FILES = ['web/styles.css', 'web/soft.css', 'web/account.css', 'web/login.css', 'web/motion.css']
SKIP_SELECTOR = re.compile(r'docx|pdf-page|^:root$|^html\[data-ui="soft"\]$')
COLOR = re.compile(r'#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^)]*\)')

# ---------- sRGB <-> OKLCH ----------
def _lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def _gam(c): return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
def to_oklch(r, g, b):
    r, g, b = _lin(r), _lin(g), _lin(b)
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return L, math.hypot(A, B), math.atan2(B, A)
def from_oklch(L, C, h):
    A, B = C * math.cos(h), C * math.sin(h)
    l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return [min(1, max(0, _gam(min(1, max(0, v))))) for v in (r, g, b)]

def parse(tok):
    if tok.startswith('#'):
        h = tok[1:]
        if len(h) in (3, 4): h = ''.join(c * 2 for c in h)
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return r, g, b, a
    nums = re.findall(r'[\d.]+%?', tok)
    vals = [float(n[:-1]) / 100 if n.endswith('%') else float(n) for n in nums]
    r, g, b = (v / 255 for v in vals[:3])
    return r, g, b, (vals[3] if len(vals) > 3 else 1.0)

def fmt(rgb, a):
    r, g, b = (round(v * 255) for v in rgb)
    if a >= 0.999: return f'#{r:02x}{g:02x}{b:02x}'
    return f'rgba({r},{g},{b},{round(a, 3):g})'

def darken(tok, kind):
    r, g, b, a = parse(tok)
    L, C, h = to_oklch(r, g, b)
    if kind == 'fg':
        if L >= 0.93 and C < 0.03: return tok                  # 彩色按钮上的白字
        L2, C2 = max(0.78, min(0.93, 1.02 - L * 0.4)), min(C, 0.13)
        return fmt(from_oklch(L2, C2, h), a)
    if kind == 'shadow':
        if L > 0.5: L = 0.12                                    # 浅色光晕在深底上没意义，改成暗影
        return fmt(from_oklch(min(L, 0.15), C * 0.5, h), min(0.6, a * 1.8))
    if a < 0.6 and kind in ('bg', 'border') and L < 0.5:        # 半透明「压暗」蒙层 / 线 → 反相成「提亮」
        return fmt(from_oklch(1 - L * 0.4, C * 0.6, h), a)
    if kind == 'border':
        if L >= 0.75: return fmt(from_oklch(0.36 + (1 - L) * 0.3, min(C * 1.3, 0.05), h), a)
        if L < 0.45: return fmt(from_oklch(0.62, C, h), a)
        return tok
    # bg
    if L >= 0.8:
        return fmt(from_oklch(max(0.17, 0.25 - (1 - L) * 1.2), min(C * 1.5, 0.06), h), a)
    if C >= 0.03: return fmt(from_oklch(L * 0.92, C, h), a)     # 饱和彩色底（按钮、徽标）
    if L >= 0.5: return fmt(from_oklch(1.22 - L, C, h), a)       # 中灰（圆点、分隔）
    return fmt(from_oklch(max(L, 0.3), C, h), a)                 # 本来就深的底（提示条、浮层）

def kind_of(prop):
    p = prop.strip().lower()
    if p.startswith('--'):
        return 'bg' if re.search(r'bg|pale|soft|surface|line|border|fill|tint', p) else 'fg'
    if 'shadow' in p or p == 'filter': return 'shadow'
    if p.startswith(('border', 'outline', 'column-rule')): return 'border'
    if p.startswith('background') or p in ('fill',): return 'bg'
    if p in ('color', 'stroke', 'caret-color', 'text-decoration-color', '-webkit-text-fill-color', 'accent-color'): return 'fg'
    return None

def convert(css, stats):
    out, i = [], 0
    for m in re.finditer(r'([^{}]*)\{([^{}]*)\}', css):
        sel = ' '.join(re.sub(r'/\*.*?\*/', '', m.group(1), flags=re.S).split())
        body = m.group(2)
        if SKIP_SELECTOR.search(sel) or sel.startswith('@'):
            continue
        def decl(d):
            prop, val = d.group(1), d.group(2)
            kind = kind_of(prop)
            if not kind or 'mask' in prop or 'light-dark(' in val: return d.group(0)
            def one(c):
                dark = darken(c.group(0), kind)
                stats[kind] = stats.get(kind, 0) + 1
                return f'light-dark({c.group(0)},{dark})'
            return f'{prop}:{COLOR.sub(one, val)}'
        nb = re.sub(r'([-\w]+)\s*:([^;]*)', decl, body)
        if nb != body:
            out.append((m.start(2), m.end(2), nb))
    for s, e, nb in reversed(out):
        css = css[:s] + nb + css[e:]
    return css

if __name__ == '__main__':
    dry = '--dry' in sys.argv
    total = {}
    for f in FILES:
        src = open(f, encoding='utf-8').read()
        stats = {}
        dst = convert(src, stats)
        print(f, stats)
        for k, v in stats.items(): total[k] = total.get(k, 0) + v
        if not dry and dst != src: open(f, 'w', encoding='utf-8').write(dst)
    print('total', total)
