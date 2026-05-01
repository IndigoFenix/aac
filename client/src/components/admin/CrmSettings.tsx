// src/components/admin/CrmSettings.tsx
// Admin UI for the CRM landing-page chat: enable flag + system prompt override.

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, AlertCircle, RotateCcw } from 'lucide-react';
import { useCrmChatSettings, useCrmChatSettingsMutations } from '@/hooks/useAdminData';

export function CrmSettings() {
  const { data, isLoading, error } = useCrmChatSettings();
  const { updateSettings } = useCrmChatSettingsMutations();

  const [enabled, setEnabled] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [usingDefault, setUsingDefault] = useState(true);

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setSystemPrompt(data.systemPrompt);
      setUsingDefault(data.usingDefault);
    }
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center gap-2 text-destructive py-8">
        <AlertCircle className="w-5 h-5" />
        <span>Failed to load CRM chat settings.</span>
      </div>
    );
  }

  const promptDirty = systemPrompt !== data.systemPrompt;
  const enabledDirty = enabled !== data.enabled;
  const hasChanges = promptDirty || enabledDirty;

  const handleSave = () => {
    updateSettings.mutate({
      enabled,
      // Only send the prompt if the admin actually edited it.
      ...(promptDirty ? { systemPrompt } : {}),
    });
  };

  const handleResetToDefault = () => {
    updateSettings.mutate({ useDefault: true });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">CRM Landing-Page Chat</h2>
        <p className="text-muted-foreground mt-1">
          Anonymous chatbot on the landing page for potential customers. When disabled, the widget does not appear.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            Toggle the chat on or off. Choose the LLM provider and model under <em>AI Models</em> → <em>CRM Landing-Page Chat</em>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="crm-enabled" className="text-base">Enabled</Label>
              <p className="text-sm text-muted-foreground">
                {enabled ? 'The chat widget is visible on the landing page.' : 'The chat widget is hidden from visitors.'}
              </p>
            </div>
            <Switch
              id="crm-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="crm-enabled-toggle"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                System Prompt
                {usingDefault && !promptDirty && (
                  <Badge variant="outline" className="text-xs">Default</Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-2">
                The instructions the AI follows when chatting with potential customers.
                Empty out the textarea (or click "Reset to default") to fall back to the built-in prompt.
              </CardDescription>
            </div>
            {!usingDefault && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetToDefault}
                disabled={updateSettings.isPending}
                data-testid="crm-reset-prompt"
              >
                <RotateCcw className="w-4 h-4 me-2" />
                Reset to default
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={16}
            className="font-mono text-sm"
            data-testid="crm-system-prompt"
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={!hasChanges || updateSettings.isPending}
          data-testid="crm-save"
        >
          {updateSettings.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin me-2" />
          ) : (
            <Save className="w-4 h-4 me-2" />
          )}
          Save Changes
        </Button>
      </div>
    </div>
  );
}
