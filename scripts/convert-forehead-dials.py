"""One-shot migration of authored blueprints to the reworked head dials.

Two changes land together (see
planning-docs/games/world-engine/creature-body-constraints.md):

1. `faceHeight` is GONE. It only ever reached the eye-elevation term
   (`el = faceHeight*0.6 + eyeHeight + pair*0.5`), so the two dials were one
   number in disguise. eyeHeight absorbs it at the same 0.6 weight.

2. `foreheadHeight` / `foreheadLength` changed MEANING:

     OLD  the dials walked the muzzle root's TOP RIM around the cranium
          ellipse. Height picked an angle, and that angle also decided how far
          forward the root sat — so raising the brow dragged the snout back.
            rimY  = (-0.85 + 1.55*fh) * bH
            rootY = rimY - snoutUR                    (rim, not centre)
            rootZ = aL*sqrt(1 - (rimY/bH)^2) + fl     (height moved z)

     NEW  the dials ARE the root ring's centre: an independent (y, z).
            rootY = (-1 + 1.9*fh) * bH
            rootZ = aL + fl

   Rewriting fh/fl this way keeps every authored creature's face where it was.

Values are in head radii throughout (headR cancels). A blueprint may be
PARTIAL — the interchange format lets a body plan omit a field and inherit the
default — so missing inputs are read from the default head rather than
skipping the block, which would silently leave a creature unconverted.

Usage: python scripts/convert-forehead-dials.py <file.ts> [...]
"""
import io
import math
import re
import sys

FH_RANGE = (0.0, 1.0)
FL_RANGE = (0.0, 2.0)
EYE_RANGE = (-0.6, 1.2)

# blueprint.ts defaultBlueprint().head — the values a partial blueprint inherits.
DEFAULT_HEAD = {
    "lengthFrac": 1.0,
    "braincaseDome": 1.0,
    "crossSection": 1.0,
    "snoutFlatten": 1.0,
    "snoutRadiusFrac": 0.45,
    "snoutLengthFrac": 0.8,
    "foreheadHeight": 0.45,
    "foreheadLength": 0.3,
}


def find_blocks(src, key):
    """Yield (start, end) spans of each `<key>: { ... }` object literal body."""
    for m in re.finditer(r'["\']?' + key + r'["\']?\s*:\s*\{', src):
        depth = 0
        i = m.end() - 1
        while i < len(src):
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
                if depth == 0:
                    yield m.end(), i
                    break
            i += 1


def read_num(block, key, fallback=None):
    m = re.search(r'["\']?' + key + r'["\']?\s*:\s*(-?[\d.eE+]+)', block)
    return fallback if m is None else float(m.group(1))


def fmt(v):
    return f"{round(v, 4):g}"


def clamp(v, lo_hi):
    return min(lo_hi[1], max(lo_hi[0], v))


def convert(path):
    src = io.open(path, encoding="utf-8").read()
    out, pos, done, skipped, folded = [], 0, 0, 0, 0
    for start, end in find_blocks(src, "head"):
        block = src[start:end]
        # A head block with no forehead dial at all is not a body plan (or is
        # a fragment); leave it exactly as it is.
        if read_num(block, "foreheadHeight") is None:
            skipped += 1
            continue
        v = {k: read_num(block, k, d) for k, d in DEFAULT_HEAD.items()}
        new_block = block

        # 1) faceHeight → eyeHeight.
        face_h = read_num(block, "faceHeight")
        if face_h is not None:
            eye_h = read_num(block, "eyeHeight", 0.35)
            merged = clamp(eye_h + 0.6 * face_h, EYE_RANGE)
            new_block = re.sub(r'\s*["\']?faceHeight["\']?\s*:\s*-?[\d.eE+]+\s*,', "",
                               new_block, count=1)
            if re.search(r'["\']?eyeHeight["\']?\s*:', new_block):
                new_block = re.sub(r'(["\']?eyeHeight["\']?\s*:\s*)-?[\d.eE+]+',
                                   lambda m: m.group(1) + fmt(merged), new_block, count=1)
            else:
                # No eyeHeight of its own: the fold has to become one.
                new_block = re.sub(r'(["\']?foreheadHeight["\']?\s*:)',
                                   lambda m: f"eyeHeight: {fmt(merged)}, " + m.group(1),
                                   new_block, count=1)
            folded += 1

        # 2) forehead dials, only where there IS a muzzle to seat.
        if v["snoutLengthFrac"] > 1e-4:
            aL, bH = v["lengthFrac"], v["braincaseDome"]
            aspect = max(0.35, min(3.0, v["snoutFlatten"] * v["crossSection"]))
            snout_ur = v["snoutRadiusFrac"] / math.sqrt(aspect)
            rim_y = (-0.85 + 1.55 * v["foreheadHeight"]) * bH
            old_y = rim_y - snout_ur
            old_z = aL * math.sqrt(max(0.0, 1 - (rim_y / bH) ** 2)) + v["foreheadLength"]
            fh = clamp((old_y / bH + 1) / 1.9, FH_RANGE)
            fl = clamp(old_z - aL, FL_RANGE)
            new_block = re.sub(r'(["\']?foreheadHeight["\']?\s*:\s*)-?[\d.eE+]+',
                               lambda m: m.group(1) + fmt(fh), new_block, count=1)
            new_block = re.sub(r'(["\']?foreheadLength["\']?\s*:\s*)-?[\d.eE+]+',
                               lambda m: m.group(1) + fmt(fl), new_block, count=1)
        out.append(src[pos:start])
        out.append(new_block)
        pos = end
        done += 1
    out.append(src[pos:])
    if done or folded:
        io.open(path, "w", encoding="utf-8", newline="").write("".join(out))
    print(f"  {path}: {done} head block(s) converted ({folded} faceHeight folded), {skipped} skipped")


for p in sys.argv[1:]:
    convert(p)
