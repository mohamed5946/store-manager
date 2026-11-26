"""WCAG contrast verification for Store Manager PC theme (E/F work).
Computes ratios for candidate tokens; run: python3 /tmp/contrast.py"""
import math

def lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def lum(hexs):
    h = hexs.lstrip('#')
    if len(h) == 3:
        h = ''.join(ch * 2 for ch in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

def ratio(fg, bg):
    l1, l2 = lum(fg), lum(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)

def blend(fg_hex, alpha, bg_hex):
    """alpha-blend fg over bg -> solid hex"""
    def ch(f, b):
        return round(alpha * f + (1 - alpha) * b)
    fh = fg_hex.lstrip('#'); bh = bg_hex.lstrip('#')
    fr, fg_, fb = int(fh[0:2], 16), int(fh[2:4], 16), int(fh[4:6], 16)
    br, bg_, bb = int(bh[0:2], 16), int(bh[2:4], 16), int(bh[4:6], 16)
    return '#%02X%02X%02X' % (ch(fr, br), ch(fg_, bg_), ch(fb, bb))

def check(name, fg, bg, need):
    r = ratio(fg, bg)
    print(f"  {'PASS' if r >= need else 'FAIL'} {name}: {fg} on {bg} = {r:.2f}:1 (need {need})")
    return r >= need

DARK = dict(bg='#0B1430', surf='#0E163C', card='#1C285A', hov='#18224C', act='#223063')
LIGHT = dict(bg='#F7F2EA', surf='#FFFFFF', card='#FFFFFF', hov='#EFE7D8', act='#E6DCC8')

# --- candidate text tokens ---
dark_text = dict(t1='#F7F2EA', t2='#B1B1BC', t3='#9FA1B0',
                 grn='#22C55E', red='#F87171', goldtx='#F0C75E',
                 acctx='#FF7A1A', orn='#FF7A1A', purtx='#D8B4FE', bronz='#F5B544')
light_text = dict(t1='#1C285A', t2='#454F6E', t3='#5B6579',
                  grn='#166534', red='#B91C1C', goldtx='#854D0E',
                  acctx='#9A3412', orn='#9A3412', purtx='#7E22CE', bronz='#8A4D00')

print("== DARK theme: t1>=7, t2/t3>=4.5 on bg/surf/card/hov ==")
ok = True
for tok, need in (('t1', 7.0), ('t2', 4.5), ('t3', 4.5)):
    for surf in ('bg', 'surf', 'card', 'hov'):
        ok &= check(f"{tok} on {surf}", dark_text[tok], DARK[surf], need)
print("== LIGHT theme ==")
for tok, need in (('t1', 7.0), ('t2', 4.5), ('t3', 4.5)):
    for surf in ('bg', 'surf', 'card', 'hov'):
        ok &= check(f"{tok} on {surf}", light_text[tok], LIGHT[surf], need)

print("== DARK: coloured text tokens >=4.5 on bg/surf/card ==")
for tok in ('grn', 'red', 'goldtx', 'acctx', 'orn', 'purtx', 'bronz'):
    for surf in ('bg', 'surf', 'card'):
        ok &= check(f"{tok} on {surf}", dark_text[tok], DARK[surf], 4.5)
print("== LIGHT: coloured text tokens >=4.5 on bg/surf/card ==")
for tok in ('grn', 'red', 'goldtx', 'acctx', 'orn', 'purtx', 'bronz'):
    for surf in ('bg', 'surf', 'card'):
        ok &= check(f"{tok} on {surf}", light_text[tok], LIGHT[surf], 4.5)

print("== Badge text on its glow background (glow blended over card) ==")
# dark glows (lowered alphas so badge text keeps >=4.5): grng .12, redg .08, goldg .18,
# accg .12, orng .10, purg .14
dark_badges = [
    ('bx-g grn', '#22C55E', blend('#22C55E', .12, '#1C285A')),
    ('bx-r red', '#F87171', blend('#F87171', .08, '#1C285A')),
    ('bx-o goldtx', '#F0C75E', blend('#F0C75E', .18, '#1C285A')),
    ('bx-b acctx', '#FF7A1A', blend('#FF7A1A', .12, '#1C285A')),
    ('bx-n orn', '#FF7A1A', blend('#FF7A1A', .10, '#1C285A')),
    ('bx-p purtx', '#D8B4FE', blend('#D8B4FE', .14, '#1C285A')),
    ('rank gold', '#F0C75E', blend('#F0C75E', .18, '#1C285A')),
    ('rank bronze', '#F5B544', blend('#FF7A1A', .16, '#1C285A')),
]
for name, fg, bg in dark_badges:
    ok &= check(f"DARK {name} ({bg})", fg, bg, 4.5)
light_badges = [
    ('bx-g grn', '#166534', blend('#166534', .12, '#FFFFFF')),
    ('bx-r red', '#B91C1C', blend('#B91C1C', .10, '#FFFFFF')),
    ('bx-o goldtx', '#854D0E', blend('#F0C75E', .18, '#FFFFFF')),
    ('bx-b acctx', '#9A3412', blend('#FF7A1A', .16, '#FFFFFF')),
    ('bx-n orn', '#9A3412', blend('#9A3412', .10, '#FFFFFF')),
    ('bx-p purtx', '#7E22CE', blend('#7E22CE', .10, '#FFFFFF')),
    ('rank gold', '#854D0E', blend('#F0C75E', .18, '#FFFFFF')),
    ('rank bronze', '#8A4D00', blend('#FF7A1A', .16, '#FFFFFF')),
]
for name, fg, bg in light_badges:
    ok &= check(f"LIGHT {name} ({bg})", fg, bg, 4.5)

print("== Solid-button foregrounds ==")
ok &= check("navy #1C285A on orange #FF7A1A (.btn-p/.ni.active/.fab)", '#1C285A', '#FF7A1A', 4.5)
ok &= check("navy #1C285A on orange-light #FF8A3D (.btn-p:hover)", '#1C285A', '#FF8A3D', 4.5)
ok &= check("white on redbtn #DC2626 (dark badge/confirm)", '#FFFFFF', '#DC2626', 4.5)
ok &= check("white on redbtn #B91C1C (light badge/confirm)", '#FFFFFF', '#B91C1C', 4.5)
print("== Fab-mini icons (navy, need >=3:1) on brand gradient starts ==")
for name, bg in [('orange', '#FF7A1A'), ('red', '#EF4444'), ('purple', '#B04BFF'),
                 ('gold', '#F0C75E'), ('green', '#22C55E'), ('acc2', '#FF8A3D')]:
    ok &= check(f"navy on {name} {bg}", '#1C285A', bg, 3.0)
print("== OLD values (for the report: what was failing) ==")
check("OLD dark t3 #48484a on dark card #3a3a3c", '#48484a', '#3a3a3c', 4.5)
check("OLD dark t3 #48484a on dark bg #1c1c1e", '#48484a', '#1c1c1e', 4.5)
check("OLD light t3 #aeaeb2 on white", '#aeaeb2', '#FFFFFF', 4.5)
check("OLD white on orange #FF7A1A", '#FFFFFF', '#FF7A1A', 4.5)
check("OLD white on red #EF4444", '#FFFFFF', '#EF4444', 4.5)
check("OLD red #EF4444 text on navy card #1C285A", '#EF4444', '#1C285A', 4.5)
check("OLD gold #F0C75E text on cream #F7F2EA", '#F0C75E', '#F7F2EA', 4.5)
check("OLD orange #FF7A1A text on white", '#FF7A1A', '#FFFFFF', 4.5)
print()
print("ALL PASS" if ok else "SOME CHECKS FAILED")
