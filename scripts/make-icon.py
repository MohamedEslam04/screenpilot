# Generates assets/icon.png (512x512, transparent): a rounded gradient tile
# with a play triangle and a pointer — "a pilot for screen videos".
# Run: python3 scripts/make-icon.py
from PIL import Image, ImageDraw, ImageFilter

S = 512
SS = 4  # supersample for smooth edges
W = S * SS

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

top, bottom = (67, 56, 202), (14, 165, 233)  # indigo -> sky
grad = Image.new("RGB", (W, W))
px = grad.load()
for y in range(W):
    for x in range(W):
        px[x, y] = lerp(top, bottom, (x + y) / (2 * W))

mask = Image.new("L", (W, W), 0)
m = 28 * SS
ImageDraw.Draw(mask).rounded_rectangle([m, m, W - m, W - m], radius=110 * SS, fill=255)
tile = Image.new("RGBA", (W, W), (0, 0, 0, 0))
tile.paste(grad, (0, 0), mask)

# soft shadow under the tile
shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([m, m + 14 * SS, W - m, W - m + 14 * SS], radius=110 * SS, fill=(15, 23, 42, 90))
shadow = shadow.filter(ImageFilter.GaussianBlur(14 * SS))
img = Image.alpha_composite(shadow, tile)

d = ImageDraw.Draw(img)
# play triangle
cx, cy, r = W * 0.47, W * 0.5, W * 0.2
d.polygon([(cx - r * 0.75, cy - r), (cx - r * 0.75, cy + r), (cx + r * 1.0, cy)], fill=(255, 255, 255, 255))
# pointer (the pilot) at the lower right
ax, ay, k = W * 0.62, W * 0.58, W * 0.0019
arrow = [(0, 0), (0, 118), (30, 90), (52, 140), (72, 131), (51, 82), (90, 82)]
pts = [(ax + x * k * 1.05, ay + y * k * 1.05) for x, y in arrow]
d.polygon([(x + 6 * SS, y + 6 * SS) for x, y in pts], fill=(15, 23, 42, 110))
d.polygon(pts, fill=(250, 204, 21, 255), outline=(15, 23, 42, 255))
d.line(pts + [pts[0]], fill=(15, 23, 42, 255), width=5 * SS, joint="curve")

img.resize((S, S), Image.LANCZOS).save("assets/icon.png")
print("assets/icon.png")
