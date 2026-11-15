import sys, math
from PIL import Image, ImageDraw, ImageFilter, ImageFont
K = 4                                   # draw at 4x, scale down for smooth edges
W, H = 512 * K, 423 * K                 # Samsung TV app icon size
out = sys.argv[1]

# Background: dark navy with a soft blue lift, like the app's loading screen
bg = Image.new('RGB', (W, H))
px = bg.load()
a, b = (9, 12, 22), (22, 44, 92)
for y in range(H):
    for x in range(0, W, 4):
        t = min(1, max(0, (x / W) * 0.55 + (1 - y / H) * 0.6))
        c = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
        for k in range(4):
            if x + k < W: px[x + k, y] = c
img = bg.convert('RGBA')
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((W * .15, H * .2, W * .85, H * .8), fill=(78, 161, 255, 60))
img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(110)))

def mark(img, cx, top, size):
    """House with a film reel inside. size = house width."""
    d = ImageDraw.Draw(img)
    s = size / 1472.0                   # proportions from the square icon (house 288..1760 wide)
    P = lambda x, y: (cx + (x - 1024) * s, top + (y - 330) * s)
    house = [P(1024, 330), P(1760, 980), P(1580, 980), P(1580, 1720), P(468, 1720), P(468, 980), P(288, 980)]
    sh = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x, y + 30) for x, y in house], fill=(0, 0, 0, 120))
    img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(30)))
    d = ImageDraw.Draw(img)
    d.polygon(house, fill=(255, 255, 255, 255))
    cx2, cy2 = P(1024, 1300); R = 340 * s
    d.ellipse((cx2 - R, cy2 - R, cx2 + R, cy2 + R), fill=(59, 140, 240, 255))
    for i in range(5):
        ang = -math.pi / 2 + i * 2 * math.pi / 5
        hx, hy, r = cx2 + 195 * s * math.cos(ang), cy2 + 195 * s * math.sin(ang), 78 * s
        d.ellipse((hx - r, hy - r, hx + r, hy + r), fill=(255, 255, 255, 255))
    d.ellipse((cx2 - 46 * s, cy2 - 46 * s, cx2 + 46 * s, cy2 + 46 * s), fill=(255, 255, 255, 255))
    return img


# Wordmark only: "Reel" light white + "house" bold blue, as on the loading screen, centred and sized to the width
d = ImageDraw.Draw(img)
size = int(H * 0.30)
while True:
    light = ImageFont.truetype('C:/Windows/Fonts/segoeuil.ttf', size)
    bold = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', size)
    w1 = d.textlength('Reel', font=light); w2 = d.textlength('house', font=bold)
    if w1 + w2 <= W * 0.86: break
    size -= 4
x = (W - (w1 + w2)) / 2
d.text((x, H / 2), 'Reel', font=light, fill=(255, 255, 255, 255), anchor='lm')
d.text((x + w1, H / 2), 'house', font=bold, fill=(92, 168, 255, 255), anchor='lm')

img.resize((512, 423), Image.LANCZOS).save(out)
print('saved', out)
