// server/services/social-game/socialGameOptions.ts
//
// The list of social games a person can ATTACH TO A CALL (the in-call game
// picker). Always the built-in default world, plus any multiplayer custom apps
// owned by the institute. Each option is a ready-to-use CallGame — custom apps
// carry their certified WorldSpec inline so every participant renders the same
// world without a second fetch (built-ins reference a worldSpecKey instead).

import type { CallGame } from "@shared/realtime-events";
import { WORLD_APP_TYPE } from "@shared/world-engine/types";
import { certifyWorldSpec } from "@shared/world-engine/index";
import { DEFAULT_SOCIAL_GAME } from "@shared/social-world/default-game";
import { customAppRepository } from "../../repositories/customAppRepository";

/** Engine types whose apps are multiplayer (selectable as a social game). */
const MULTIPLAYER_TYPES = [WORLD_APP_TYPE];

export async function listSocialGameOptions(instituteId: string): Promise<CallGame[]> {
  const options: CallGame[] = [DEFAULT_SOCIAL_GAME];

  const apps = await customAppRepository.listMultiplayerAppsForInstitute(instituteId, MULTIPLAYER_TYPES);
  for (const app of apps) {
    const full = await customAppRepository.getApp(app.id);
    if (!full) continue;
    const certified = certifyWorldSpec(full.definition);
    if (!certified.ok) continue; // skip apps whose stored spec no longer certifies
    options.push({
      appId: app.id,
      engine: WORLD_APP_TYPE,
      name: app.name ?? certified.spec.meta.title,
      worldSpec: certified.spec,
      maxPlayers: certified.spec.multiplayer.maxPlayers,
    });
  }

  return options;
}
