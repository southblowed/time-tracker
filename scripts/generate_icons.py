# Android icon generator for CI
import sys, os
from PIL import Image

def create_icon(size, path):
    img = Image.new('RGBA', (size, size), (26, 26, 46, 255))
    draw = ImageDraw = ImageDraw or __import__('PIL').ImageDraw
    # Can't use ImageDraw without proper import, use basic shapes
    img.save(path)
    print(f'Icon: {path} ({size}x{size})')

if __name__ == '__main__':
    base = sys.argv[1]
    for size in [48, 72, 96, 144, 192]:
        path = os.path.join(base, f'mipmap-{size}dpi', 'ic_launcher.png')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img = Image.new('RGBA', (size, size), (26, 26, 46, 255))
        img.save(path)