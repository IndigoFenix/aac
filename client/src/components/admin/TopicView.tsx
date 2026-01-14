// src/components/admin/TopicView.tsx
// View a single topic with its content and subtopics

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { useLocation } from 'wouter';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ChevronRight,
  ArrowLeft,
  FolderOpen,
  Home,
} from 'lucide-react';
import {
  useTopic,
  useTopics,
  useTopicMutations,
  type Topic,
} from '@/hooks/useAdminData';
import { TopicForm } from './TopicForm';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

interface TopicViewProps {
  topicId: string;
}

export function TopicView({ topicId }: TopicViewProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: topicData, isLoading: isLoadingTopic, error: topicError } = useTopic(topicId);
  const { data: subtopics, isLoading: isLoadingSubtopics } = useTopics(topicId);
  const { updateTopic, deleteTopic } = useTopicMutations();

  const [editingTopic, setEditingTopic] = useState<Topic | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteConfirmTopic, setDeleteConfirmTopic] = useState<Topic | null>(null);
  const [isEditingCurrent, setIsEditingCurrent] = useState(false);

  const topic = topicData?.topic;
  const path = topicData?.path || [];

  const handleToggleActive = async (t: Topic) => {
    try {
      await updateTopic.mutateAsync({
        id: t.id,
        data: { active: !t.active },
      });
      toast({
        title: t.active ? 'Topic deactivated' : 'Topic activated',
      });
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to update topic',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (cascade: boolean) => {
    if (!deleteConfirmTopic) return;
    const isCurrentTopic = deleteConfirmTopic.id === topicId;
    try {
      await deleteTopic.mutateAsync({ id: deleteConfirmTopic.id, cascade });
      toast({ title: 'Topic deleted' });
      setDeleteConfirmTopic(null);
      // If we deleted the current topic, navigate back
      if (isCurrentTopic) {
        const parentId = topic?.parentId;
        if (parentId) {
          navigate(`/admin/library/${parentId}`);
        } else {
          navigate('/admin/library');
        }
      }
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete topic',
        variant: 'destructive',
      });
    }
  };

  const handleEditSubtopic = (t: Topic, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTopic(t);
    setIsEditingCurrent(false);
    setIsFormOpen(true);
  };

  const handleEditCurrentTopic = () => {
    if (topic) {
      setEditingTopic(topic);
      setIsEditingCurrent(true);
      setIsFormOpen(true);
    }
  };

  const handleCreateSubtopic = () => {
    setEditingTopic(null);
    setIsEditingCurrent(false);
    setIsFormOpen(true);
  };

  const handleFormClose = () => {
    setIsFormOpen(false);
    setEditingTopic(null);
    setIsEditingCurrent(false);
  };

  const handleSubtopicClick = (t: Topic) => {
    navigate(`/admin/library/${t.id}`);
  };

  const handleBack = () => {
    if (topic?.parentId) {
      navigate(`/admin/library/${topic.parentId}`);
    } else {
      navigate('/admin/library');
    }
  };

  if (isLoadingTopic) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (topicError || !topic) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-destructive">
          {topicError ? `Error: ${topicError.message}` : 'Topic not found'}
        </p>
        <Button variant="outline" onClick={() => navigate('/admin/library')}>
          <ArrowLeft className="w-4 h-4 me-2" />
          Back to Library
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink
              className="cursor-pointer flex items-center gap-1"
              onClick={() => navigate('/admin/library')}
            >
              <Home className="w-4 h-4" />
              Library
            </BreadcrumbLink>
          </BreadcrumbItem>
          {path.slice(0, -1).map((p) => (
            <BreadcrumbItem key={p.id}>
              <BreadcrumbSeparator />
              <BreadcrumbLink
                className="cursor-pointer"
                onClick={() => navigate(`/admin/library/${p.id}`)}
              >
                {p.title}
              </BreadcrumbLink>
            </BreadcrumbItem>
          ))}
          <BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbPage>{topic.title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Back Button and Actions */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={handleBack}>
          <ArrowLeft className="w-4 h-4 me-2" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleEditCurrentTopic}>
            <Pencil className="w-4 h-4 me-2" />
            Edit Topic
          </Button>
          <Button
            variant="outline"
            onClick={() => setDeleteConfirmTopic(topic)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="w-4 h-4 me-2" />
            Delete
          </Button>
        </div>
      </div>

      {/* Topic Header */}
      <Card className={!topic.active ? 'opacity-60' : ''}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-2xl">{topic.title}</CardTitle>
            <div className="flex items-center gap-2">
              <Checkbox
                id="active-current"
                checked={topic.active}
                onCheckedChange={() => handleToggleActive(topic)}
              />
              <label htmlFor="active-current" className="text-sm text-muted-foreground cursor-pointer">
                Active
              </label>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {topic.content ? (
            <div className="whitespace-pre-wrap text-sm text-muted-foreground">
              {topic.content}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">No content</p>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Subtopics Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Subtopics</h2>
          <Button onClick={handleCreateSubtopic} size="sm">
            <Plus className="w-4 h-4 me-2" />
            Add Subtopic
          </Button>
        </div>

        {isLoadingSubtopics ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : subtopics && subtopics.length > 0 ? (
          <div className="space-y-2">
            {subtopics.map((subtopic) => (
              <Card
                key={subtopic.id}
                className={`cursor-pointer transition-colors hover:bg-accent/50 ${!subtopic.active ? 'opacity-60' : ''}`}
                onClick={() => handleSubtopicClick(subtopic)}
              >
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FolderOpen className="w-5 h-5 text-muted-foreground" />
                      <div>
                        <CardTitle className="text-base">{subtopic.title}</CardTitle>
                        {subtopic.content && (
                          <CardDescription className="line-clamp-1 mt-1">
                            {subtopic.content.substring(0, 80)}
                            {subtopic.content.length > 80 ? '...' : ''}
                          </CardDescription>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2 me-4">
                        <Checkbox
                          id={`active-${subtopic.id}`}
                          checked={subtopic.active}
                          onCheckedChange={() => handleToggleActive(subtopic)}
                        />
                        <label
                          htmlFor={`active-${subtopic.id}`}
                          className="text-sm text-muted-foreground cursor-pointer"
                        >
                          Active
                        </label>
                      </div>

                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => handleEditSubtopic(subtopic, e)}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirmTopic(subtopic);
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                      <ChevronRight className="w-5 h-5 text-muted-foreground" />
                    </div>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-8">
              <p className="text-muted-foreground mb-4">No subtopics</p>
              <Button onClick={handleCreateSubtopic} size="sm">
                <Plus className="w-4 h-4 me-2" />
                Add Subtopic
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Topic Form Dialog */}
      <TopicForm
        open={isFormOpen}
        onClose={handleFormClose}
        topic={editingTopic}
        parentId={isEditingCurrent ? topic.parentId : topicId}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmTopic} onOpenChange={() => setDeleteConfirmTopic(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Topic</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteConfirmTopic?.title}"?
              {deleteConfirmTopic?.childCount && deleteConfirmTopic.childCount > 0 ? (
                <span className="block mt-2 text-destructive">
                  This topic has subtopics. You can delete only this topic or delete it with all subtopics.
                </span>
              ) : (
                <span className="block mt-2">This action cannot be undone.</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {deleteConfirmTopic?.childCount && deleteConfirmTopic.childCount > 0 ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => handleDelete(false)}
                  disabled={deleteTopic.isPending}
                >
                  Delete Only This
                </Button>
                <AlertDialogAction
                  onClick={() => handleDelete(true)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete All
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction
                onClick={() => handleDelete(false)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
