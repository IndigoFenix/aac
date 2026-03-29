// src/components/FeedbackDialog.tsx
// In-app bug report / support request dialog for logged-in users

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useInstitute } from '@/hooks/useInstitute';
import { useLanguage } from '@/contexts/LanguageContext';
import { apiRequest } from '@/lib/queryClient';
import { Loader2, Bug, HelpCircle } from 'lucide-react';

interface FeedbackDialogProps {
  open: boolean;
  onClose: () => void;
  defaultType?: 'bug_report' | 'support_request';
}

export function FeedbackDialog({ open, onClose, defaultType = 'bug_report' }: FeedbackDialogProps) {
  const { user } = useAuth();
  const { currentInstitute } = useInstitute();
  const { t, language } = useLanguage();
  const { toast } = useToast();

  const [messageType, setMessageType] = useState<'bug_report' | 'support_request'>(defaultType);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!message.trim()) {
      toast({
        title: t('common.error') || 'Error',
        description: t('feedback.messageRequired') || 'Please describe the issue',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('POST', '/api/contact', {
        messageType,
        firstName: user?.firstName || '',
        lastName: user?.lastName || '',
        email: user?.email || '',
        organization: currentInstitute?.name || 'N/A',
        role: 'other',
        message: message.trim(),
      });

      toast({
        title: t('feedback.sent') || 'Message Sent',
        description: t('feedback.sentDesc') || 'Thank you for your feedback. We will get back to you soon.',
      });

      setMessage('');
      onClose();
    } catch (err: any) {
      toast({
        title: t('common.error') || 'Error',
        description: err.message || t('feedback.sendFailed') || 'Failed to send message',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setMessage('');
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t('feedback.title') || 'Send Feedback'}
          </DialogTitle>
          <DialogDescription>
            {t('feedback.description') || 'Report a bug or request support. We will respond to your email.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Message Type */}
          <div className="space-y-2">
            <Label>{t('feedback.type') || 'Type'}</Label>
            <Select value={messageType} onValueChange={(v) => setMessageType(v as typeof messageType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bug_report">
                  <span className="flex items-center gap-2">
                    <Bug className="w-4 h-4" />
                    {t('feedback.bugReport') || 'Bug Report'}
                  </span>
                </SelectItem>
                <SelectItem value="support_request">
                  <span className="flex items-center gap-2">
                    <HelpCircle className="w-4 h-4" />
                    {t('feedback.supportRequest') || 'Support Request'}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Email (read-only) */}
          <div className="space-y-2">
            <Label>{t('feedback.email') || 'Your Email'}</Label>
            <Input value={user?.email || ''} disabled className="bg-muted" dir="ltr" />
          </div>

          {/* Message */}
          <div className="space-y-2">
            <Label>{t('feedback.message') || 'Message'} *</Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                messageType === 'bug_report'
                  ? (t('feedback.bugPlaceholder') || 'Describe what happened and what you expected...')
                  : (t('feedback.supportPlaceholder') || 'How can we help you?')
              }
              rows={5}
              disabled={isSubmitting}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel') || 'Cancel'}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !message.trim()}>
            {isSubmitting ? (
              <Loader2 className="w-4 h-4 animate-spin me-2" />
            ) : null}
            {t('feedback.send') || 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
