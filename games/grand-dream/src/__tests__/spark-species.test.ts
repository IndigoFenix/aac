/**
 * THE PLAYER IS A SPARK — its own species, not one of the people in the world.
 *
 * The player creature used to be seeded BARE (`{ id: "player" }`, no species)
 * and told apart from in-game humans only by ~90 `id === "player"` string
 * compares. That reads as "species not set yet" rather than "not a human", and
 * it left nothing stopping the creature builder from standing a default body
 * where the player should be an unrendered light.
 */
import { describe, it, expect } from "vitest";
import {
  getSpecies, requireSpecies, listSpecies, speciesOfKind, SPARK_SPECIES_ID,
} from "@shared/world-engine/creatures/species";

describe("the spark species", () => {
  it("is registered as a built-in", () => {
    const spark = requireSpecies(SPARK_SPECIES_ID);
    expect(spark.id).toBe("spark");
    expect(spark.kind).toBe("spark");
  });

  it("is BODILESS — it renders as a light, never a mesh", () => {
    const spark = requireSpecies(SPARK_SPECIES_ID);
    expect(spark.bodiless).toBe(true);
    expect(spark.blueprint).toEqual({});
  });

  it("is NOT a creature — it can never be mistaken for one of the world's people", () => {
    // The distinction that matters: anything enumerating the world's creature
    // body plans (a cast generator, a species menu) must not offer the player.
    const creatures = speciesOfKind("creature").map((s) => s.id);
    expect(creatures).not.toContain(SPARK_SPECIES_ID);
    expect(creatures).toContain("human");
  });

  it("is the ONLY bodiless species — every other one can be built", () => {
    const bodiless = listSpecies().filter((s) => s.bodiless).map((s) => s.id);
    expect(bodiless).toEqual([SPARK_SPECIES_ID]);
  });

  it("resolves through the ordinary registry lookups", () => {
    expect(getSpecies(SPARK_SPECIES_ID)).toBeDefined();
    expect(getSpecies("no_such_species")).toBeUndefined();
  });
});
