// src/components/admin/TopicForm.tsx
// Form for creating and editing topics

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import {
  useTopicMutations,
  type Topic,
  type CreateTopicData,
  type UpdateTopicData,
} from '@/hooks/useAdminData';

interface TopicFormProps {
  open: boolean;
  onClose: () => void;
  topic: Topic | null; // null for create, Topic for edit
  parentId: string | null; // Parent topic ID for new topics
}

export function TopicForm({ open, onClose, topic, parentId }: TopicFormProps) {
  const { toast } = useToast();
  const { createTopic, updateTopic } = useTopicMutations();
  const isEditing = !!topic;

  const [formData, setFormData] = useState({
    title: '',
    content: '',
    active: true,
  });

  // Reset form when dialog opens/closes or topic changes
  useEffect(() => {
    if (open) {
      if (topic) {
        setFormData({
          title: topic.title,
          content: topic.content,
          active: topic.active,
        });
      } else {
        setFormData({
          title: '',
          content: '',
          active: true,
        });
      }
    }
  }, [open, topic]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!formData.title.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Title is required',
        variant: 'destructive',
      });
      return;
    }

    try {
      if (isEditing) {
        await updateTopic.mutateAsync({
          id: topic.id,
          data: formData as UpdateTopicData,
        });
        toast({ title: 'Topic updated successfully' });
      } else {
        await createTopic.mutateAsync({
          ...formData,
          parentId: parentId,
        } as CreateTopicData);
        toast({ title: 'Topic created successfully' });
      }
      onClose();
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || `Failed to ${isEditing ? 'update' : 'create'} topic`,
        variant: 'destructive',
      });
    }
  };

  const isLoading = createTopic.isPending || updateTopic.isPending;

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Edit Topic' : 'Create Topic'}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the topic title and content'
              : parentId
                ? 'Create a new subtopic'
                : 'Create a new top-level topic'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={formData.title}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, title: e.target.value }))
              }
              placeholder="e.g., Communication Strategies"
            />
            <p className="text-xs text-muted-foreground">
              Title must be unique within the same parent topic
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="content">Content</Label>
            <Textarea
              id="content"
              value={formData.content}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, content: e.target.value }))
              }
              placeholder="Enter the topic content (plain text for AI reference)..."
              rows={12}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              This content will be accessible to the AI when this topic is viewed.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="active"
              checked={formData.active}
              onCheckedChange={(checked) =>
                setFormData((prev) => ({
                  ...prev,
                  active: checked === true,
                }))
              }
            />
            <Label htmlFor="active" className="cursor-pointer">
              Active
            </Label>
            <span className="text-xs text-muted-foreground">
              (Inactive topics are hidden from users and AI)
            </span>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {isEditing ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
