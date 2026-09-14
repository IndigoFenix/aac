// client/src/lib/chatFileIntake.ts
//
// The ONE place the clinician chat decides which files it takes in. Three
// doors feed it — the paperclip picker, drag-and-drop, and clipboard paste —
// and all three must accept exactly the same set, so the picker's `accept`
// string and the drop/paste filter derive from the same list here.
//
// Pure module (no DOM objects constructed) so it is unit-testable under the
// node-environment client jest config: `npm run test:client-app -- chatFileIntake`.

/** Extensions the paperclip picker offers. Keep lowercase, with the dot. */
export const CHAT_FILE_EXTENSIONS = [
  '.pdf', '.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
] as const;

/** Mime types accepted regardless of the filename (a pasted screenshot arrives
 *  as `image.png`, but some browsers hand over a blob with no useful name). */
const CHAT_FILE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The `accept` attribute for the hidden `<input type="file">`. */
export const CHAT_FILE_ACCEPT = CHAT_FILE_EXTENSIONS.join(',');

/** The subset of `File` the filter needs — tests pass plain objects. */
export type FileLike = Pick<File, 'name' | 'type'>;

export function isAcceptedChatFile(file: FileLike): boolean {
  if (file.type && CHAT_FILE_MIME_TYPES.has(file.type.toLowerCase())) return true;
  const name = (file.name || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return (CHAT_FILE_EXTENSIONS as readonly string[]).includes(name.slice(dot));
}

export interface SplitFiles<F extends FileLike> {
  accepted: F[];
  rejected: F[];
}

export function splitAcceptedChatFiles<F extends FileLike>(files: Iterable<F>): SplitFiles<F> {
  const out: SplitFiles<F> = { accepted: [], rejected: [] };
  for (const f of files) (isAcceptedChatFile(f) ? out.accepted : out.rejected).push(f);
  return out;
}

/** The slice of `DataTransfer` the extractors read — drag and clipboard share it. */
export interface DataTransferLike<F extends FileLike = File> {
  files?: ArrayLike<F> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): F | null }> | null;
  types?: ArrayLike<string> | null;
}

/** True when a drag carries files (as opposed to text or a link), so the
 *  drop overlay only shows for something we can take. */
export function dragCarriesFiles(dt: DataTransferLike | null | undefined): boolean {
  if (!dt?.types) return false;
  return Array.from(dt.types).includes('Files');
}

/**
 * Files carried by a drop or a paste. Prefers `files`; falls back to
 * `items` of kind "file" (what the clipboard exposes for a pasted image in
 * some browsers). Never returns null entries, and de-duplicates the same
 * object appearing in both lists.
 */
export function filesFromDataTransfer<F extends FileLike>(dt: DataTransferLike<F> | null | undefined): F[] {
  if (!dt) return [];
  const seen = new Set<F>();
  const out: F[] = [];
  const push = (f: F | null | undefined) => {
    if (f && !seen.has(f)) { seen.add(f); out.push(f); }
  };
  if (dt.files) Array.from(dt.files).forEach(push);
  if (out.length === 0 && dt.items) {
    Array.from(dt.items).forEach((item) => {
      if (item.kind === 'file') push(item.getAsFile());
    });
  }
  return out;
}
