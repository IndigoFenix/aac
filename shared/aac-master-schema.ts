import { z } from "zod";

/** Reusable bits */
const ActionType = z.enum([
  "speak",
  "navigate", 
  "back",
  "open_url",
  "play_audio",
  "stop_audio",
  "play_video",
  "stop_video",
  "add_to_message_window",
  "clear_message_window",
  "clipboard_copy",
  "sequence"
]);

const Action: z.ZodType<{
  type: string;
  text?: string;
  target_board_id?: string;
  url?: string;
  audio_id?: string;
  video_id?: string;
  ops?: any[];
}> = z.object({
  type: ActionType,
  text: z.string().optional(),
  target_board_id: z.string().optional(),
  url: z.string().url().optional(),
  audio_id: z.string().optional(),
  video_id: z.string().optional(),
  ops: z.lazy(() => z.array(Action)).optional()
});

const ActionList = z.array(Action);

const Cell = z.object({
  id: z.string(),
  row: z.number().int().min(1),
  col: z.number().int().min(1),
  row_span: z.number().int().min(1).default(1).optional(),
  col_span: z.number().int().min(1).default(1).optional(),

  label: z.string().optional(),
  speak: z.string().optional(),
  pronunciation: z.string().optional(),
  lang: z.string().optional(),

  symbol_id: z.string().optional(),
  image_id: z.string().optional(),
  audio_id: z.string().optional(),
  video_id: z.string().optional(),

  style: z.object({
    bg: z.string().optional(),
    fg: z.string().optional(),
    label_position: z.enum(["top", "bottom", "left", "right", "hidden"]).optional(),
    border_px: z.number().optional()
  }).optional(),

  category: z.string().optional(),
  actions: ActionList.optional()
});

const BoardLayout = z.object({
  rows: z.number().int().min(1),
  cols: z.number().int().min(1),
  gutter: z.number().int().min(0).default(0).optional(),
  theme: z.object({
    background: z.string().optional(),
    default_cell_color: z.string().optional(),
    font_family: z.string().optional(),
    font_size_pt: z.number().optional()
  }).optional()
});

const Board = z.object({
  id: z.string(),
  name: z.string(),
  layout: BoardLayout,
  on_enter: ActionList.optional(),
  on_exit: ActionList.optional(),
  cells: z.array(Cell)
});

const AssetSymbol = z.object({
  id: z.string(),
  set: z.string(), // pcs, symbolstix, arasaac, widgets, custom
  ref: z.string(), // code or path
  file: z.string().optional(),
  alt_text: z.string().optional()
});

const AssetImage = z.object({
  id: z.string(),
  file: z.string(),
  license: z.string().optional(),
  alt_text: z.string().optional()
});

const AssetAudio = z.object({
  id: z.string(),
  file: z.string(),
  license: z.string().optional()
});

const AssetVideo = z.object({
  id: z.string(),
  file: z.string().optional(),
  url: z.string().url().optional(),
  license: z.string().optional()
}).refine(v => Boolean(v.file || v.url), {
  message: "video asset must include file or url"
});

const Assets = z.object({
  symbols: z.array(AssetSymbol).default([]).optional(),
  images: z.array(AssetImage).default([]).optional(),
  audio: z.array(AssetAudio).default([]).optional(),
  videos: z.array(AssetVideo).default([]).optional()
});

const Meta = z.object({
  version: z.string(),
  title: z.string(),
  description: z.string().optional(),
  locale: z.string(),
  authors: z.array(z.string()).default([]).optional(),
  targets: z.object({
    grid3: z.boolean().default(true).optional(),
    tdsnap: z.boolean().default(true).optional(),
    openboard_obz: z.boolean().default(false).optional()
  }).default({ grid3: true, tdsnap: true, openboard_obz: false }).optional()
});

export const AacMasterSchema = z.object({
  meta: Meta,
  assets: Assets,
  boards: z.array(Board)
});

export type AacMaster = z.infer<typeof AacMasterSchema>;
export type AacAction = z.infer<typeof Action>;
export type AacCell = z.infer<typeof Cell>;
export type AacBoard = z.infer<typeof Board>;
export type AacAssets = z.infer<typeof Assets>;
export type AacMeta = z.infer<typeof Meta>;

// Validation function with referential integrity checks
export function validateAacMaster(data: AacMaster): void {
  const symbolIds = new Set((data.assets.symbols ?? []).map(s => s.id));
  const imageIds = new Set((data.assets.images ?? []).map(i => i.id));
  const audioIds = new Set((data.assets.audio ?? []).map(a => a.id));
  const videoIds = new Set((data.assets.videos ?? []).map(v => v.id));
  const boardIds = new Set(data.boards.map(b => b.id));

  for (const b of data.boards) {
    for (const c of b.cells) {
      if (c.symbol_id && !symbolIds.has(c.symbol_id)) {
        throw new Error(`Cell ${c.id} on board ${b.id} references missing symbol_id ${c.symbol_id}`);
      }
      if (c.image_id && !imageIds.has(c.image_id)) {
        throw new Error(`Cell ${c.id} on board ${b.id} references missing image_id ${c.image_id}`);
      }
      if (c.audio_id && !audioIds.has(c.audio_id)) {
        throw new Error(`Cell ${c.id} on board ${b.id} references missing audio_id ${c.audio_id}`);
      }
      if (c.video_id && !videoIds.has(c.video_id)) {
        throw new Error(`Cell ${c.id} on board ${b.id} references missing video_id ${c.video_id}`);
      }
      if (c.actions) {
        for (const a of c.actions) {
          if (a.type === "link" && a.target_board_id && !boardIds.has(a.target_board_id)) {
            throw new Error(`Cell ${c.id} on board ${b.id} navigates to missing board_id ${a.target_board_id}`);
          }
          if (a.type === "play_audio" && a.audio_id && !audioIds.has(a.audio_id)) {
            throw new Error(`Cell ${c.id} on board ${b.id} plays missing audio_id ${a.audio_id}`);
          }
          if (a.type === "play_video" && a.video_id && !videoIds.has(a.video_id)) {
            throw new Error(`Cell ${c.id} on board ${b.id} plays missing video_id ${a.video_id}`);
          }
        }
      }
    }
  }
}