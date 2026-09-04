/**
 * L3 — blendshapes to action units.
 *
 * The two things worth pinning here are both about ABSENCE, because both have
 * already caused live bugs in this codebase's decoders:
 *
 *   * a missing blendshape must be OMITTED, never averaged in as zero — that is
 *     the same "absent is not zero" rule the seizure baseline follows for a limb
 *     that was out of frame; and
 *   * an attenuated channel must be FLAGGED, never used as a gate, because a
 *     composite that requires a channel this model pins near zero is
 *     structurally incapable of firing (D2).
 */

import { describe, it, expect } from "@jest/globals";
import {
  ACTION_UNITS, ACTION_UNIT_BY_ID, computeActionUnits,
  toChannelValues, channelRange, channelLabel, channelAttenuated,
  auChannel, geomChannel, FACE_CHANNELS, GEOMETRY_CHANNELS, GEOMETRY_RANGES,
} from "../../shared/aac/face-aus.js";

const bs = (o: Record<string, number>) => new Map(Object.entries(o));

describe("the mapping table", () => {
  it("has a unique id, a name and a plain-language label for every unit", () => {
    const ids = new Set<string>();
    for (const d of ACTION_UNITS) {
      expect(ids.has(d.id)).toBe(false);
      ids.add(d.id);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.label.length).toBeGreaterThan(0);
      // No FACS jargon may reach the AI — the label is what gets rendered.
      expect(d.label).not.toMatch(/AU\d/);
    }
  });

  it("gives every unit at least one contributing blendshape", () => {
    for (const d of ACTION_UNITS) {
      expect((d.left?.length ?? 0) + (d.right?.length ?? 0) + (d.mid?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it("keeps sided units symmetric — a one-sided pair would bias the asymmetry", () => {
    for (const d of ACTION_UNITS) {
      if (d.left || d.right) {
        expect(d.left?.length ?? 0).toBe(d.right?.length ?? 0);
      }
    }
  });

  it("flags the channels this model is known or suspected to attenuate", () => {
    // eyeWide* is the documented case (MediaPipe #5329); cheekSquint* is the
    // Duchenne marker and has never been measured on this population.
    expect(ACTION_UNIT_BY_ID.AU05.attenuated).toBe(true);
    expect(ACTION_UNIT_BY_ID.AU06.attenuated).toBe(true);
    expect(ACTION_UNIT_BY_ID.AU12.attenuated).toBeUndefined();
  });
});

describe("computeActionUnits", () => {
  it("averages the two sides of a sided unit", () => {
    const aus = computeActionUnits(bs({ mouthSmileLeft: 0.8, mouthSmileRight: 0.4 }));
    expect(aus.AU12!.value).toBeCloseTo(0.6);
    expect(aus.AU12!.left).toBeCloseTo(0.8);
    expect(aus.AU12!.right).toBeCloseTo(0.4);
    expect(aus.AU12!.asymmetry).toBeCloseTo(0.4);
  });

  it("OMITS a side the model did not report rather than averaging a zero in", () => {
    const aus = computeActionUnits(bs({ mouthSmileLeft: 0.8 }));
    // A present-side-only reading is 0.8, NOT 0.4.
    expect(aus.AU12!.value).toBeCloseTo(0.8);
    expect(aus.AU12!.right).toBeUndefined();
    // And with one side missing there is no asymmetry to report.
    expect(aus.AU12!.asymmetry).toBeUndefined();
  });

  it("leaves a unit out entirely when nothing contributing was reported", () => {
    const aus = computeActionUnits(bs({ mouthSmileLeft: 0.5 }));
    expect(aus.AU12).toBeDefined();
    expect(aus.AU04).toBeUndefined();
  });

  it("returns an empty map for an empty or absent blendshape set", () => {
    expect(computeActionUnits(undefined)).toEqual({});
    expect(computeActionUnits(new Map())).toEqual({});
  });

  it("subtracts the inhibitor for lips-parted, so a closed mouth with a dropped jaw is not parted", () => {
    const open = computeActionUnits(bs({ jawOpen: 0.8, mouthClose: 0 }));
    const clenched = computeActionUnits(bs({ jawOpen: 0.8, mouthClose: 0.8 }));
    expect(open.AU25!.value).toBeCloseTo(0.8);
    expect(clenched.AU25!.value).toBeCloseTo(0);
    // Jaw drop itself is unaffected — the jaw IS down in both.
    expect(clenched.AU26!.value).toBeCloseTo(0.8);
  });

  it("clamps to 0..1", () => {
    const aus = computeActionUnits(bs({ jawOpen: 5, mouthClose: 0 }));
    expect(aus.AU26!.value).toBe(1);
    const neg = computeActionUnits(bs({ jawOpen: 0.1, mouthClose: 0.9 }));
    expect(neg.AU25!.value).toBe(0);
  });

  it("reads a real smile as AU12, and a Duchenne one as AU12 + AU6", () => {
    const social = computeActionUnits(bs({ mouthSmileLeft: 0.7, mouthSmileRight: 0.7 }));
    const felt = computeActionUnits(bs({
      mouthSmileLeft: 0.7, mouthSmileRight: 0.7,
      cheekSquintLeft: 0.6, cheekSquintRight: 0.6,
    }));
    expect(social.AU12!.value).toBeCloseTo(felt.AU12!.value);
    expect(social.AU06).toBeUndefined();
    expect(felt.AU06!.value).toBeCloseTo(0.6);
  });
});

describe("the channel namespace", () => {
  it("covers every action unit and every geometry feature, with no duplicates", () => {
    expect(new Set(FACE_CHANNELS).size).toBe(FACE_CHANNELS.length);
    expect(FACE_CHANNELS.length).toBe(ACTION_UNITS.length + GEOMETRY_CHANNELS.length);
    for (const d of ACTION_UNITS) expect(FACE_CHANNELS).toContain(auChannel(d.id));
    for (const g of GEOMETRY_CHANNELS) expect(FACE_CHANNELS).toContain(geomChannel(g));
  });

  it("gives every channel a plain-language label", () => {
    for (const c of FACE_CHANNELS) {
      expect(channelLabel(c)).not.toBe(c);
      expect(channelLabel(c).length).toBeGreaterThan(0);
    }
  });

  it("gives AUs the 0..1 intensity range and geometry its own declared range", () => {
    expect(channelRange(auChannel("AU12"))).toEqual({ min: 0, max: 1 });
    expect(channelRange(geomChannel("mouthWidth"))).toEqual(GEOMETRY_RANGES.mouthWidth);
    // A signed feature must have a range that spans zero, or half its values
    // clamp into the bottom bin and the median is meaningless.
    expect(GEOMETRY_RANGES.lipCornerElevLeft.min).toBeLessThan(0);
  });

  it("declares a non-degenerate range for every geometry channel", () => {
    for (const g of GEOMETRY_CHANNELS) {
      expect(GEOMETRY_RANGES[g].max).toBeGreaterThan(GEOMETRY_RANGES[g].min);
    }
  });

  it("falls back to 0..1 for an unknown channel rather than producing NaN bins", () => {
    expect(channelRange("geom:nonesuch")).toEqual({ min: 0, max: 1 });
  });

  it("reports attenuation only for AU channels that declare it", () => {
    expect(channelAttenuated(auChannel("AU05"))).toBe(true);
    expect(channelAttenuated(auChannel("AU12"))).toBe(false);
    expect(channelAttenuated(geomChannel("mouthAspect"))).toBe(false);
  });
});

describe("toChannelValues", () => {
  it("flattens AUs and geometry into one namespace", () => {
    const aus = computeActionUnits(bs({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }));
    const v = toChannelValues(aus, { mouthAspect: 0.2, interocular: 0.1 });
    expect(v.get(auChannel("AU12"))).toBeCloseTo(0.5);
    expect(v.get(geomChannel("mouthAspect"))).toBeCloseTo(0.2);
  });

  it("leaves an unobserved geometry feature ABSENT, not zero", () => {
    const v = toChannelValues({}, { mouthAspect: 0.2 });
    expect(v.has(geomChannel("mouthWidth"))).toBe(false);
    // The distinction that matters: `undefined` must not read as a sample of 0.
    expect(v.get(geomChannel("mouthWidth"))).toBeUndefined();
  });

  it("does not baseline interocular distance — that tracks the tablet, not the face", () => {
    const v = toChannelValues({}, { interocular: 0.12 });
    expect([...v.keys()].some((k) => k.includes("interocular"))).toBe(false);
  });

  it("survives absent geometry entirely", () => {
    const aus = computeActionUnits(bs({ jawOpen: 0.3 }));
    const v = toChannelValues(aus, undefined);
    expect(v.get(auChannel("AU26"))).toBeCloseTo(0.3);
    expect(v.size).toBeGreaterThan(0);
  });
});
