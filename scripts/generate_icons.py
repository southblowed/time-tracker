# Android icon generator for CI
import sys, os
from PIL import Image

DENSITY_MAP = {
    48: 'mipmap-mdpi',
    72: 'mipmap-hdpi',
    96: 'mipmap-xhdpi',
    144: 'mipmap-xxhdpi',
    192: 'mipmap-xxxhdpi',
}

if __name__ == '__main__':
    base = sys.argv[1]
    for size, folder in DENSITY_MAP.items():
        path = os.path.join(base, folder, 'ic_launcher.png')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img = Image.new('RGBA', (size, size), (26, 26, 46, 255))
        img.save(path)
        print(f'Icon: {folder} ({size}x{size})')