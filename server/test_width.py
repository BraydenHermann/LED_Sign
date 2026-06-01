import sys
from PIL import Image, ImageDraw, ImageFont

text = "FS Team - 12:00 pm"
target_h = 18
font_path = "C:/Windows/Fonts/arial.ttf"
try:
    font = ImageFont.truetype(font_path, target_h)
except:
    font = ImageFont.load_default()

test_img = Image.new("1", (4000, 40), 0)
test_draw = ImageDraw.Draw(test_img)
test_draw.text((0, 0), text, font=font, fill=1)
bbox = test_img.getbbox()
print(f"Width of '{text}' at {target_h}px: {bbox[2] - bbox[0]}")
