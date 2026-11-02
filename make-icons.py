# אייקוני האפליקציה (PWA) מתוך public/og.png — להריץ: python3 make-icons.py
from PIL import Image
import os
os.makedirs("public/icons", exist_ok=True)
src = Image.open("public/og.png").convert("RGBA")
def save(im, name): im.convert("RGB").quantize(64, method=Image.Quantize.MEDIANCUT).save(name, optimize=True)
for s in (192, 512):
    save(src.resize((s, s), Image.LANCZOS), f"public/icons/icon-{s}.png")
    bg = Image.new("RGBA", (s, s), (11, 10, 14, 255)); inner = int(s * 0.78)
    bg.alpha_composite(src.resize((inner, inner), Image.LANCZOS), ((s - inner) // 2, (s - inner) // 2))
    save(bg, f"public/icons/maskable-{s}.png")
save(src.resize((180, 180), Image.LANCZOS), "public/icons/apple-touch-icon.png")
print("icons:", sorted(os.listdir("public/icons")))
