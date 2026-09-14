// client/src/hooks/useChatFileIntake.ts
//
// Drag-and-drop and clipboard-paste doors for the clinician chat. Both feed
// the same `uploadFile` the paperclip picker calls, and filter with the same
// accept list (see lib/chatFileIntake.ts), so a file arrives identically no
// matter which door it came through.
//
// Usage:
//   const intake = useChatFileIntake({ uploadFile, disabled: isUploadingFile });
//   <div {...intake.dropZoneProps}> … {intake.isDragOver && <Overlay/>} … </div>
//   <textarea onPaste={intake.onPaste} />

import { useCallback, useRef, useState } from 'react';
import type React from 'react';
import { toast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  dragCarriesFiles,
  filesFromDataTransfer,
  splitAcceptedChatFiles,
} from '@/lib/chatFileIntake';

export interface UseChatFileIntakeOptions {
  uploadFile: (file: File) => Promise<unknown>;
  /** When true, drops and pastes are ignored (e.g. an upload is in flight). */
  disabled?: boolean;
}

export interface ChatFileIntake {
  isDragOver: boolean;
  dropZoneProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  onPaste: (e: React.ClipboardEvent) => void;
  /** The shared intake: filters, toasts rejects, uploads the rest in order. */
  takeFiles: (files: File[]) => Promise<void>;
}

export function useChatFileIntake({ uploadFile, disabled = false }: UseChatFileIntakeOptions): ChatFileIntake {
  const { t } = useLanguage();
  const [isDragOver, setIsDragOver] = useState(false);
  // dragenter/dragleave fire for every child crossed; a depth counter keeps
  // the overlay steady until the pointer leaves the zone itself.
  const dragDepth = useRef(0);

  const takeFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const { accepted, rejected } = splitAcceptedChatFiles(files);
    for (const file of rejected) {
      toast({
        variant: 'destructive',
        title: t('chat.uploadFailed'),
        description: t('chat.fileTypeNotSupported', { filename: file.name || file.type }),
      });
    }
    // Sequential, exactly like the picker's handleFileSelect.
    for (const file of accepted) {
      await uploadFile(file);
    }
  }, [uploadFile, t]);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (disabled || !dragCarriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragOver(true);
  }, [disabled]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (disabled || !dragCarriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [disabled]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!dragCarriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!dragCarriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    if (disabled) return;
    void takeFiles(filesFromDataTransfer(e.dataTransfer));
  }, [disabled, takeFiles]);

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    if (disabled) return;
    const files = filesFromDataTransfer(e.clipboardData);
    if (files.length === 0) return; // plain text paste — leave it to the textarea
    e.preventDefault();
    void takeFiles(files);
  }, [disabled, takeFiles]);

  return {
    isDragOver,
    dropZoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
    onPaste,
    takeFiles,
  };
}
