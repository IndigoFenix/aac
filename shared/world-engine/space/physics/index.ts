// shared/space/physics/ — seagull-dream's planetary PHYSICS system, ported
// verbatim into the engine. Pure (only THREE.Color + mulberry32 + stellar
// physics from shared/space): a star + system seed → the full deterministic
// solar system as bodies with their evolved state and derived FEATURES.
//
// `BodyFeatures` is the planet's CHARACTER — tectonic activity, hydrosphere,
// atmosphere, temperature, terrain relief budget, life. This is the feature
// SOURCE that parameterizes the shared world model's geography (sphere
// tectonics → substrate → civ) at the terrain seam; seagull's own noise
// `heightAt` is the ONLY part not ported (it's replaced by that model).
//
// Entry points:
//   materializeSystem(star, galaxyParams) → SystemBlueprint (formation data)
//   resolveSystem(blueprint, galaxyAgeGyr) → ResolvedBody[] { body, state, features }
//   buildHomeBlueprint(...) — the pinned Sol blueprint (home system)

export * from "./body";
export * from "./features";
export * from "./system";
export * from "./home-system";
