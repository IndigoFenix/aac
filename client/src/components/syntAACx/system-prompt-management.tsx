import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Settings, Save, Info, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

// Types
interface SystemPrompt {
  id: string;
  prompt: string;
  updatedAt: string;
  updatedBy?: string;
}

// Form validation schema
const systemPromptSchema = z.object({
  prompt: z.string()
});

type SystemPromptForm = z.infer<typeof systemPromptSchema>;

export default function SystemPromptManagement() {
  const { toast } = useToast();

  // Form setup
  const form = useForm<SystemPromptForm>({
    resolver: zodResolver(systemPromptSchema),
    defaultValues: {
      prompt: ""
    }
  });

  // Fetch system prompt
  const { data: systemPrompt, isLoading, refetch } = useQuery<SystemPrompt>({
    queryKey: ["/api/admin/system-prompt"],
    refetchInterval: 30000 // Refresh every 30 seconds
  });

  // Update system prompt mutation
  const updateSystemPromptMutation = useMutation({
    mutationFn: async (data: SystemPromptForm) => {
      const response = await apiRequest("PUT", "/api/admin/system-prompt", data);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "System Prompt Updated",
        description: "The AI behavior prompt has been updated successfully.",
        variant: "default"
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-prompt"] });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update system prompt",
        variant: "destructive"
      });
    }
  });

  // Update form when data changes
  useEffect(() => {
    if (systemPrompt) {
      form.reset({
        prompt: systemPrompt.prompt || ""
      });
    }
  }, [systemPrompt, form]);

  // Handle form submission
  const onSubmit = (data: SystemPromptForm) => {
    updateSystemPromptMutation.mutate(data);
  };

  // Handle reset to empty
  const handleReset = () => {
    form.reset({ prompt: "" });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            System Prompt Configuration
          </CardTitle>
          <CardDescription>
            Configure the AI behavior prompt that will be used when generating AAC boards from user prompts
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Information Alert */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          This prompt will be sent to the AI model along with every user request to provide context and instructions on how to convert prompts into AAC board layouts. 
          Leave empty to use the default AI behavior, or add specific instructions to customize the board generation process.
        </AlertDescription>
      </Alert>

      {/* Main Form */}
      <Card>
        <CardHeader>
          <CardTitle>Current System Prompt</CardTitle>
          <CardDescription>
            {systemPrompt?.prompt ? 
              `Last updated: ${new Date(systemPrompt.updatedAt).toLocaleString()}` : 
              "No system prompt configured - using default AI behavior"
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="prompt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>System Prompt</FormLabel>
                      <FormControl>
                        <Textarea 
                          {...field} 
                          placeholder="Enter system prompt to define AI behavior when generating AAC boards... Leave empty for default behavior."
                          className="min-h-[200px] font-mono text-sm"
                          data-testid="textarea-system-prompt"
                        />
                      </FormControl>
                      <FormMessage />
                      <div className="text-sm text-muted-foreground">
                        Character count: {field.value?.length || 0}
                      </div>
                    </FormItem>
                  )}
                />

                <div className="flex justify-between pt-4">
                  <div className="flex gap-2">
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={handleReset}
                      data-testid="button-reset-prompt"
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Clear
                    </Button>
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={() => refetch()}
                      data-testid="button-refresh-prompt"
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Refresh
                    </Button>
                  </div>
                  <Button 
                    type="submit" 
                    disabled={updateSystemPromptMutation.isPending}
                    data-testid="button-save-system-prompt"
                  >
                    <Save className="h-4 w-4 mr-2" />
                    {updateSystemPromptMutation.isPending ? "Saving..." : "Save System Prompt"}
                  </Button>
                </div>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>

      {/* Example Prompts */}
      <Card>
        <CardHeader>
          <CardTitle>Example System Prompts</CardTitle>
          <CardDescription>
            Here are some example prompts you can use as starting points
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium">Basic AAC Board Generation:</h4>
            <div className="p-3 bg-gray-50 rounded-md text-sm font-mono">
              You are an expert AAC (Augmentative and Alternative Communication) board designer. 
              When given a user prompt, create comprehensive communication boards with appropriate symbols, 
              text, and layout for users with communication needs. Focus on practical vocabulary, 
              clear organization, and accessibility.
            </div>
          </div>
          
          <div className="space-y-2">
            <h4 className="font-medium">Educational Focus:</h4>
            <div className="p-3 bg-gray-50 rounded-md text-sm font-mono">
              Create educational AAC boards that support learning and communication in classroom settings. 
              Include vocabulary for subjects, activities, emotions, and social interactions. 
              Organize content by topics and include both core and fringe vocabulary appropriate for the learning context.
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Therapy-Focused:</h4>
            <div className="p-3 bg-gray-50 rounded-md text-sm font-mono">
              Design AAC boards for therapeutic settings with emphasis on functional communication, 
              expressing needs, feelings, and preferences. Include social phrases, requesting vocabulary, 
              and words that support independence and self-advocacy.
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}