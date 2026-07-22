#!/usr/bin/env python3
"""Draw a 24x24 running-person icon and emit a PNG (stdlib only, no PIL)."""
import struct, zlib, sys

N = 24
grid = [[0] * N for _ in range(N)]


def disc(cx, cy, r):
    for y in range(N):
        for x in range(N):
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r:
                grid[y][x] = 1


def bar(x0, y0, x1, y1, w):
    """Thick line = every pixel within w/2 of the segment."""
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy
    for y in range(N):
        for x in range(N):
            px, py = x + 0.5, y + 0.5
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / L2))
            qx, qy = x0 + t * dx, y0 + t * dy
            if (px - qx) ** 2 + (py - qy) ** 2 <= (w / 2.0) ** 2:
                grid[y][x] = 1


# Figure runs to the right, leaning forward.
#
# Three constraints, each learned by drawing it wrong first:
#  - Strokes stay ~2px. Anything thicker and the limbs merge into one blob.
#  - Arms live in rows 6-12, legs below row 12. Overlap them and a trailing hand
#    and a trailing foot fuse together.
#  - The hands sit at different heights and the front knee is lifted with the
#    shin tucked back. Symmetric limbs read as a jumping figure, not a running
#    one, and the raised hand must clear the head or the two become one mass.
disc(15.4, 3.2, 2.3)                      # head
bar(14.6, 6.2, 11.6, 13.0, 2.8)           # torso, shoulder -> hip

bar(14.0, 8.2, 18.2, 10.2, 2.2)            # front arm: shoulder -> elbow
bar(18.2, 10.2, 21.0, 8.4, 2.0)            # front arm: elbow -> hand, cocked high

bar(13.2, 8.6, 9.2, 10.0, 2.2)            # back arm: shoulder -> elbow
bar(9.2, 10.0, 6.8, 12.0, 2.0)            # back arm: elbow -> hand, trailing low

bar(12.0, 13.0, 17.0, 15.2, 2.6)          # front leg: thigh, knee driven up
bar(17.0, 15.2, 15.6, 19.4, 2.4)          # front leg: shin tucked back under
bar(15.4, 19.8, 18.0, 20.4, 2.0)          # front foot

bar(11.4, 13.2, 6.8, 16.4, 2.6)           # back leg: hip -> knee
bar(6.8, 16.4, 3.4, 19.2, 2.2)            # back leg: shin, extended back
bar(3.4, 19.6, 2.0, 20.2, 2.0)            # back foot, toe-off

grid[:] = [[0]*N] + grid[:-1]   # nudge down 1px so the margins match

for row in grid:
    print(''.join('#' if v else '.' for v in row))
print(f"lit: {sum(map(sum, grid))}/{N*N}")


def png(path, fg):
    """White/coloured figure on a transparent background, RGBA."""
    raw = b''
    for y in range(N):
        raw += b'\x00'
        for x in range(N):
            raw += bytes(fg + (255,)) if grid[y][x] else b'\x00\x00\x00\x00'

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(raw, 9))
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)
    print(f"wrote {path} ({len(out)} bytes)")


for arg in sys.argv[1:]:
    p, _, col = arg.partition(':')
    rgb = tuple(int(col[i:i+2], 16) for i in (0, 2, 4)) if col else (255, 255, 255)
    png(p, rgb)
