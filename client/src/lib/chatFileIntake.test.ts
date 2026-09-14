// client/src/lib/chatFileIntake.test.ts
//
/// <reference types="jest" />
//
// Run with:  npm run test:client-app -- chatFileIntake

import {
  CHAT_FILE_ACCEPT,
  dragCarriesFiles,
  filesFromDataTransfer,
  isAcceptedChatFile,
  splitAcceptedChatFiles,
} from './chatFileIntake';

const f = (name: string, type = '') => ({ name, type });

describe('CHAT_FILE_ACCEPT', () => {
  it('is the picker accept string the paperclip has always used', () => {
    expect(CHAT_FILE_ACCEPT).toBe(
      '.pdf,.txt,.md,.json,.csv,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.h,.hpp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp',
    );
  });
});

describe('isAcceptedChatFile', () => {
  it('accepts by extension, case-insensitively', () => {
    expect(isAcceptedChatFile(f('report.PDF'))).toBe(true);
    expect(isAcceptedChatFile(f('notes.docx', 'application/octet-stream'))).toBe(true);
  });

  it('accepts a pasted image by mime even with an unhelpful name', () => {
    expect(isAcceptedChatFile(f('blob', 'image/png'))).toBe(true);
    expect(isAcceptedChatFile(f('', 'image/jpeg'))).toBe(true);
  });

  it('rejects what the picker would not offer', () => {
    expect(isAcceptedChatFile(f('clip.mp4', 'video/mp4'))).toBe(false);
    expect(isAcceptedChatFile(f('archive.zip'))).toBe(false);
    expect(isAcceptedChatFile(f('noext'))).toBe(false);
    expect(isAcceptedChatFile(f('tricky.pdf.exe'))).toBe(false);
  });
});

describe('splitAcceptedChatFiles', () => {
  it('keeps order within each bucket', () => {
    const a = f('a.txt');
    const b = f('b.exe');
    const c = f('c.png', 'image/png');
    expect(splitAcceptedChatFiles([a, b, c])).toEqual({ accepted: [a, c], rejected: [b] });
  });
});

describe('dragCarriesFiles', () => {
  it('is true only when the drag types include Files', () => {
    expect(dragCarriesFiles({ types: ['Files'] })).toBe(true);
    expect(dragCarriesFiles({ types: ['text/plain', 'text/uri-list'] })).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
    expect(dragCarriesFiles({})).toBe(false);
  });
});

describe('filesFromDataTransfer', () => {
  it('reads files first', () => {
    const a = f('a.txt');
    expect(filesFromDataTransfer({ files: [a], items: [] })).toEqual([a]);
  });

  it('falls back to file-kind items and skips string items and nulls', () => {
    const img = f('image.png', 'image/png');
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => img },
      { kind: 'file', getAsFile: () => null },
    ];
    expect(filesFromDataTransfer({ files: [], items })).toEqual([img]);
  });

  it('returns nothing for a text paste', () => {
    expect(filesFromDataTransfer({ files: [], items: [{ kind: 'string', getAsFile: () => null }] })).toEqual([]);
    expect(filesFromDataTransfer(null)).toEqual([]);
  });
});
