// shared/guessing-mode/suggestion-registry.ts
//
// Frontend-owned (but shared) presentation for every suggestion button. Keyed
// by `${cluster}:${value}` so a shared cluster (place, body_part, …) has ONE
// set of entries reused under every namespace it's instantiated in.
//
// `icon` is EITHER an emoji (used directly) or a snake_case imageKey. The board
// build pipeline runs the same resolution as for any AI button: an emoji is
// kept, a snake_case key with a known emoji is swapped in, and anything left
// over is queued for the symbol generator. So a handful of abstract concepts
// (e.g. "belly", "kitchen-as-room") intentionally fall through to generation.

import type { SuggestionEntry } from "./types.js";
import { DIMENSION_BY_ID, CATEGORY_VALUES, CATEGORY_DIM_ID } from "./dimensions.js";

// [labelEn, icon] per value, grouped by cluster. labelKey is derived as
// `guessing.<cluster>.<value>` at flatten time.
const CLUSTERS: Record<string, Record<string, [string, string]>> = {
  category: {
    things: ["A thing", "📦"],
    actions: ["Something you do", "🏃"],
    people: ["A person", "👥"],
    places: ["A place", "🏠"],
    feelings: ["A feeling", "😊"],
    time: ["A time", "🕒"],
  },

  // ── place (shared: where_found) ──
  place: {
    at_home: ["At home", "🏠"],
    at_school: ["At school", "🏫"],
    in_the_city: ["In town", "🏙️"],
    in_nature: ["Outside in nature", "🌳"],
    far_away: ["Somewhere far", "🗺️"],
  },
  home_room: {
    kitchen: ["Kitchen", "🍳"],
    bedroom: ["Bedroom", "🛏️"],
    bathroom: ["Bathroom", "🛁"],
    living_room: ["Living room", "🛋️"],
    closet: ["Closet", "🚪"],
  },
  school_area: {
    classroom: ["Classroom", "🏫"],
    playground: ["Playground", "🛝"],
    lunchroom: ["Lunchroom", "🍱"],
  },
  natural_places: {
    water: ["In the water", "🌊"],
    sky: ["In the sky", "☁️"],
    grass: ["In the grass", "🌱"],
    forest: ["In the forest", "🌲"],
    mountains: ["In the mountains", "⛰️"],
    desert: ["In the desert", "🏜️"],
    snow: ["In the snow", "❄️"],
    underground: ["Underground", "🕳️"],
  },

  // ── body_part (shared) ──
  body_part: {
    head: ["Head", "👤"],
    chest_heart: ["Chest", "❤️"],
    belly: ["Tummy", "belly"],
    arm: ["Arm", "💪"],
    leg: ["Leg", "🦵"],
    eye: ["Eye", "👁️"],
    nose: ["Nose", "👃"],
    mouth: ["Mouth", "👄"],
    ear: ["Ear", "👂"],
  },

  // ── feeling cluster ──
  valence: {
    good: ["A good feeling", "🙂"],
    bad: ["A bad feeling", "😞"],
    mixed: ["A mixed feeling", "😐"],
  },
  named_feeling: {
    happy: ["Happy", "😊"],
    sad: ["Sad", "😢"],
    angry: ["Angry", "😠"],
    afraid: ["Scared", "😨"],
    hurt: ["Hurt", "🤕"],
    excited: ["Excited", "🤩"],
    calm: ["Calm", "😌"],
    tired: ["Tired", "😴"],
  },
  pain_scale: {
    a_little: ["A little", "🙂"],
    medium: ["Medium", "😣"],
    a_lot: ["A lot", "😭"],
  },
  intensity: {
    strong: ["Strong", "💪"],
    small: ["Small", "🤏"],
  },

  // ── action cluster ──
  pace: {
    fast: ["Fast", "💨"],
    slow: ["Slow", "🐢"],
  },
  who: {
    alone: ["By myself", "🧍"],
    with_others: ["With others", "👫"],
    together: ["Together", "🤝"],
  },
  action_where: {
    inside: ["Inside", "🏠"],
    outside: ["Outside", "🌳"],
    on_screen: ["On a screen", "📺"],
  },
  uses_tool: {
    yes_tool: ["Use something", "🔧"],
    no_tool: ["Just my body", "✋"],
  },
  purpose: {
    fun: ["For fun", "🎉"],
    work: ["A job to do", "💼"],
  },

  // ── things: kind + descriptive ──
  kind: {
    animal: ["An animal", "🐾"],
    food: ["Food", "🍎"],
    toy: ["A toy", "🧸"],
    clothes: ["Clothes", "👕"],
    tool: ["A tool", "🔧"],
    vehicle: ["Something that goes", "🚗"],
    screen: ["From a screen", "📺"],
    nature_thing: ["Something in nature", "🌳"],
  },
  size: {
    tiny: ["Tiny", "🐜"],
    medium: ["Medium", "🐕"],
    big: ["Big", "🐘"],
  },
  color: {
    red: ["Red", "🔴"],
    orange_c: ["Orange", "🟠"],
    yellow: ["Yellow", "🟡"],
    green: ["Green", "🟢"],
    blue: ["Blue", "🔵"],
    purple: ["Purple", "🟣"],
    pink: ["Pink", "🩷"],
    brown: ["Brown", "🟤"],
    black: ["Black", "⚫"],
    white: ["White", "⚪"],
  },
  real_or_imagined: {
    real_thing: ["A real thing", "🌍"],
    from_a_show: ["From a show or game", "📺"],
  },
  where_known: {
    real_life: ["Seen it for real", "👀"],
    on_screen_known: ["On a screen", "📺"],
    in_a_book: ["In a book", "📖"],
  },

  // ── animal sub-clusters ──
  animal_covering: {
    furry: ["Furry", "🐻"],
    feathers: ["Feathers", "🪶"],
    scales: ["Scales", "🐍"],
    shell: ["A shell", "🐢"],
    skin: ["Smooth skin", "🐸"],
  },
  animal_diet: {
    eats_meat: ["Eats meat", "🥩"],
    eats_plants: ["Eats plants", "🌿"],
    eats_fish: ["Eats fish", "🐟"],
    eats_bugs: ["Eats bugs", "🐛"],
    eats_many: ["Eats lots of things", "🍽️"],
  },

  // ── food sub-clusters ──
  taste: {
    sweet: ["Sweet", "🍬"],
    salty: ["Salty", "🧂"],
    sour: ["Sour", "🍋"],
    plain: ["Plain", "🍞"],
  },
  temperature: {
    hot: ["Hot", "🔥"],
    warm: ["Warm", "☀️"],
    cold: ["Cold", "🧊"],
  },
  food_texture: {
    crunchy: ["Crunchy", "🥨"],
    soft_food: ["Soft", "🍦"],
    liquid_food: ["A drink", "🥤"],
  },
  food_when: {
    breakfast: ["Breakfast", "🥣"],
    lunch: ["Lunch", "🥪"],
    dinner: ["Dinner", "🍽️"],
    snack: ["A snack", "🍿"],
    treat: ["A treat", "🍰"],
  },

  // ── clothes sub-clusters ──
  clothes_when: {
    everyday: ["Every day", "👕"],
    fancy: ["Fancy", "👗"],
    weather_clothes: ["For the weather", "🧥"],
  },

  // ── toy sub-clusters ──
  toy_form: {
    physical_toy: ["A real toy", "🧸"],
    video_game: ["A video game", "🎮"],
    app: ["An app", "📱"],
    show_toy: ["From a show", "📺"],
  },
  play_style: {
    play_alone: ["Play by myself", "🧍"],
    play_together: ["Play together", "👫"],
  },

  // ── tool sub-clusters ──
  tool_purpose: {
    draw_write: ["To draw or write", "✏️"],
    eat_tool: ["To eat with", "🍴"],
    clean_tool: ["To clean", "🧹"],
    fix_tool: ["To fix things", "🔧"],
    move_tool: ["To help me move", "🛒"],
  },

  // ── vehicle sub-clusters ──
  vehicle_domain: {
    land: ["On land", "🚗"],
    water: ["On water", "⛵"],
    air: ["In the air", "✈️"],
    space: ["In space", "🚀"],
  },

  // ── screen sub-clusters ──
  screen_medium: {
    show: ["A TV show", "📺"],
    movie: ["A movie", "🎬"],
    video_game: ["A video game", "🎮"],
    app: ["An app", "📱"],
    youtube: ["A video", "▶️"],
  },
  screen_subject: {
    character: ["A character", "🦸"],
    place_in_it: ["A place in it", "🏰"],
    thing_in_it: ["A thing in it", "🎁"],
  },

  // ── nature sub-clusters ──
  nature_kind: {
    plant: ["A plant", "🌱"],
    weather: ["Weather", "🌦️"],
    water_body: ["Water", "🌊"],
    sky_thing: ["In the sky", "☁️"],
    ground_thing: ["On the ground", "🪨"],
  },

  // ── people ──
  relationship: {
    family: ["Family", "👪"],
    friend: ["A friend", "🧒"],
    helper: ["Someone who helps", "🤝"],
    new_person: ["Someone new", "👋"],
  },
  presence: {
    here_now: ["Here now", "📍"],
    not_here: ["Not here", "🚪"],
  },

  // ── places ──
  activity: {
    eat_there: ["Eat there", "🍽️"],
    play_there: ["Play there", "🛝"],
    learn_there: ["Learn there", "📚"],
    rest_there: ["Rest there", "🛏️"],
    shop_there: ["Shop there", "🛒"],
    get_help: ["Get help there", "🏥"],
  },

  // ── time ──
  time: {
    now: ["Now", "⏰"],
    earlier_today: ["Earlier today", "🌅"],
    yesterday: ["Yesterday", "📅"],
    long_ago: ["A long time ago", "📜"],
    soon: ["Soon", "⏳"],
    later: ["Later", "🔜"],
    bedtime: ["Bedtime", "🌙"],
    mealtime: ["Mealtime", "🍽️"],
    school_time: ["School time", "🏫"],
  },
};

/** Flattened `${cluster}:${value}` → entry. */
export const SUGGESTION_REGISTRY: Record<string, SuggestionEntry> = (() => {
  const out: Record<string, SuggestionEntry> = {};
  for (const [cluster, values] of Object.entries(CLUSTERS)) {
    for (const [value, [labelEn, icon]] of Object.entries(values)) {
      out[`${cluster}:${value}`] = {
        labelKey: `guessing.${cluster}.${value}`,
        labelEn,
        icon,
      };
    }
  }
  return out;
})();

export interface ParsedSuggestion {
  /** Namespaced dimension id, or "category". */
  dimension: string;
  value: string;
}

/** Parse a `suggestion:<dim>:<value>` button key (dim may contain dots). */
export function parseSuggestionKey(raw: string): ParsedSuggestion | null {
  const PREFIX = "suggestion:";
  if (!raw.startsWith(PREFIX)) return null;
  const rest = raw.slice(PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx <= 0 || idx >= rest.length - 1) return null;
  return { dimension: rest.slice(0, idx), value: rest.slice(idx + 1) };
}

/** Resolve the registry entry for a (dimension, value) pair. */
export function getSuggestionEntry(dimension: string, value: string): SuggestionEntry | undefined {
  if (dimension === CATEGORY_DIM_ID) return SUGGESTION_REGISTRY[`category:${value}`];
  const def = DIMENSION_BY_ID[dimension];
  if (!def) return undefined;
  return SUGGESTION_REGISTRY[`${def.cluster}:${value}`];
}

/** True when the key names a real dimension+value with a registry entry. */
export function isValidSuggestionKey(raw: string): boolean {
  const parsed = parseSuggestionKey(raw);
  if (!parsed) return false;
  const { dimension, value } = parsed;
  if (dimension === CATEGORY_DIM_ID) {
    return (CATEGORY_VALUES as string[]).includes(value) && !!SUGGESTION_REGISTRY[`category:${value}`];
  }
  const def = DIMENSION_BY_ID[dimension];
  if (!def || !def.values.includes(value)) return false;
  return !!SUGGESTION_REGISTRY[`${def.cluster}:${value}`];
}
