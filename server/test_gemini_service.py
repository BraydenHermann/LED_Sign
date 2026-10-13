"""
Unit tests for server/gemini_service.py
Verifies 64x20 matrix constraints, 300-frame limits, Pillow code execution,
and matrix conversion pipelines.
"""

import sys
import os
import unittest
from unittest.mock import patch, MagicMock
import io
import json

# Ensure server directory is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

import gemini_service


class TestGeminiService(unittest.TestCase):

    def test_status_and_hardware_limits(self):
        status = gemini_service.check_status()
        self.assertIn("configured", status)
        self.assertIn("hardware_limits", status)
        limits = status["hardware_limits"]
        self.assertEqual(limits["width"], 64)
        self.assertEqual(limits["height"], 20)
        self.assertEqual(limits["max_frames"], 300)
        self.assertEqual(limits["aspect_ratio"], "3.2:1")

    def test_system_constraints_presence(self):
        prompt = gemini_service.SYSTEM_CONSTRAINTS
        self.assertIn("64", prompt)
        self.assertIn("20", prompt)
        self.assertIn("300", prompt)
        self.assertIn("#000000", prompt)
        self.assertIn("3.2:1", prompt)

    def test_color_normalization(self):
        # Pure black (< 16, 16, 16) turns off LEDs (0)
        self.assertEqual(gemini_service._normalize_color(5, 5, 5, True), 0)
        # Saturated color rounds to multiple of 16
        c = gemini_service._normalize_color(255, 0, 128, True)
        self.assertTrue(c.startswith("#"))
        self.assertEqual(len(c), 7)

    @unittest.skipUnless(HAS_PIL, "PIL required for image matrix conversion")
    def test_convert_image_to_matrix_pixels(self):
        img = Image.new("RGB", (100, 100), (255, 0, 0))
        pixels = gemini_service.convert_image_to_matrix_pixels(img)
        self.assertEqual(len(pixels), 64 * 20)
        red_pixels = [p for p in pixels if p != 0]
        self.assertTrue(len(red_pixels) > 0)

    @unittest.skipUnless(HAS_PIL, "PIL required for GIF conversion")
    def test_convert_gif_to_matrix_pixels(self):
        frames = []
        for c in [(255, 0, 0), (0, 255, 0), (0, 0, 255)]:
            f = Image.new("RGB", (64, 20), c)
            frames.append(f)
        
        buf = io.BytesIO()
        frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=100)
        buf.seek(0)
        pil_gif = Image.open(buf)

        pixels, durations = gemini_service.convert_gif_to_matrix_pixels(pil_gif)
        self.assertEqual(len(pixels), 20 * 3 * 64)
        self.assertEqual(len(durations), 3)

    @unittest.skipUnless(HAS_PIL, "PIL required for GIF limit test")
    def test_gif_frame_limit_exceeded(self):
        fake_gif = MagicMock()
        fake_gif.n_frames = 301
        with self.assertRaises(ValueError):
            gemini_service.convert_gif_to_matrix_pixels(fake_gif)

    @unittest.skipUnless(HAS_PIL, "PIL required for code execution test")
    def test_execute_pillow_script(self):
        script = """```python
from PIL import Image, ImageDraw

frames = []
for i in range(5):
    img = Image.new('RGB', (64, 20), (0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([i*2, 2, i*2 + 10, 18], fill=(0, 255, 128))
    frames.append(img)

frames[0].save(OUTPUT_PATH, save_all=True, append_images=frames[1:], duration=80, loop=0)
```"""
        gif_bytes = gemini_service._execute_pillow_script(script, output_type="gif")
        self.assertTrue(len(gif_bytes) > 0)
        pil_gif = Image.open(io.BytesIO(gif_bytes))
        self.assertEqual(pil_gif.size, (64, 20))
        self.assertEqual(getattr(pil_gif, "n_frames", 1), 5)

    @unittest.skipUnless(HAS_PIL, "PIL required for pixel shim test")
    def test_execute_pillow_script_with_pixel_shims(self):
        # Verifies that LLM code calling draw.pixel((x, y), fill) or draw.pixel(x, y, fill)
        # succeeds without throwing "'ImageDraw' object has no attribute 'pixel'"
        script = """```python
from PIL import Image, ImageDraw

frames = []
for i in range(3):
    img = Image.new('RGB', (64, 20), (0, 0, 0))
    d = ImageDraw.Draw(img)
    d.pixel((5, 5), fill=(255, 0, 0))
    d.pixel(10, 10, (0, 255, 0))
    d.putpixel((15, 15), fill=(0, 0, 255))
    frames.append(img)

frames[0].save(OUTPUT_PATH, save_all=True, append_images=frames[1:], duration=80, loop=0)
```"""
        gif_bytes = gemini_service._execute_pillow_script(script, output_type="gif")
        self.assertTrue(len(gif_bytes) > 0)

    @unittest.skipUnless(HAS_PIL, "PIL required for time import test")
    def test_execute_pillow_script_with_time_import(self):
        # Verifies that LLM code importing time does not fail with "Importing 'time' is not permitted"
        script = """```python
import time
from PIL import Image, ImageDraw

frames = []
for i in range(3):
    img = Image.new('RGB', (64, 20), (0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([i*5, 2, i*5 + 10, 15], fill=(255, 255, 0))
    time.sleep(0.01)
    frames.append(img)

frames[0].save(OUTPUT_PATH, save_all=True, append_images=frames[1:], duration=80, loop=0)
```"""
        gif_bytes = gemini_service._execute_pillow_script(script, output_type="gif")
        self.assertTrue(len(gif_bytes) > 0)

    @unittest.skipUnless(HAS_PIL, "PIL required for from time import test")
    def test_execute_pillow_script_with_from_time_import(self):
        # Verifies that LLM code doing "from time import sleep" works without error
        script = """```python
from time import sleep
from PIL import Image, ImageDraw

frames = []
for i in range(2):
    img = Image.new('RGB', (64, 20), (0, 0, 0))
    sleep(0.01)
    frames.append(img)

frames[0].save(OUTPUT_PATH, save_all=True, append_images=frames[1:], duration=80, loop=0)
```"""
        gif_bytes = gemini_service._execute_pillow_script(script, output_type="gif")
        self.assertTrue(len(gif_bytes) > 0)

    @unittest.skipUnless(HAS_PIL, "PIL required for ImageFont test")
    def test_execute_pillow_script_with_imagefont(self):
        # Verifies that LLM code drawing text with ImageFont works properly
        script = """```python
from PIL import Image, ImageDraw, ImageFont
import itertools

font = ImageFont.load_default()
frames = []
for i in range(2):
    img = Image.new('RGB', (64, 20), (0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((2, 2), "HIGH BEAMS", fill=(255, 255, 255), font=font)
    frames.append(img)

frames[0].save(OUTPUT_PATH, save_all=True, append_images=frames[1:], duration=80, loop=0)
```"""
        gif_bytes = gemini_service._execute_pillow_script(script, output_type="gif")
        self.assertTrue(len(gif_bytes) > 0)


if __name__ == '__main__':
    unittest.main()
