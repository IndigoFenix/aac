// src/components/admin/ModelSettings.tsx
// Admin UI for configuring LLM providers per use case

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLLMConfigs, useLLMConfigMutations } from '@/hooks/useAdminData';
import { Loader2, Save, AlertCircle } from 'lucide-react';
import {
  PROVIDER_LABELS,
  getProvidersWithModels,
  modelAllowedForUseCase,
  type LLMProviderKey,
  type UseCaseKey,
  type LLMConfigValue,
  type ModelOption,
  type UseCaseInfo,
} from '@shared/llm-options';

const TIER_COLORS: Record<string, string> = {
  economy: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  standard: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  premium: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
};

export function ModelSettings() {
  const { data, isLoading, error } = useLLMConfigs();
  const { updateConfigs } = useLLMConfigMutations();

  // Local state for editing
  const [localConfigs, setLocalConfigs] = useState<Record<string, LLMConfigValue>>({});
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data?.configs) {
      setLocalConfigs(data.configs as Record<string, LLMConfigValue>);
      setHasChanges(false);
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
        <span>Failed to load LLM configurations.</span>
      </div>
    );
  }

  const { useCases, modelOptions } = data;

  const getModelsForUseCase = (provider: LLMProviderKey, useCaseKey: UseCaseKey): ModelOption[] => {
    const info = (useCases as Record<UseCaseKey, UseCaseInfo>)[useCaseKey];
    return ((modelOptions || []) as ModelOption[]).filter(
      (m) => m.provider === provider && modelAllowedForUseCase(m, info || {})
    );
  };

  const getModelInfo = (provider: LLMProviderKey, modelId: string): ModelOption | undefined => {
    return ((modelOptions || []) as ModelOption[]).find(
      (m) => m.provider === provider && m.modelId === modelId
    );
  };

  const getAvailableProviders = (useCaseKey: UseCaseKey): LLMProviderKey[] => {
    const info = (useCases as Record<UseCaseKey, UseCaseInfo>)[useCaseKey];
    // HTTP-only per-agent overrides are wired for Gemini only.
    if (info?.requiresHttp) return ['gemini'];
    return getProvidersWithModels(info?.requiresLive);
  };

  const handleProviderChange = (useCase: string, provider: LLMProviderKey) => {
    const models = getModelsForUseCase(provider, useCase as UseCaseKey);
    const firstModel = models[0]?.modelId || '';
    setLocalConfigs((prev) => ({
      ...prev,
      [useCase]: { provider, model: firstModel },
    }));
    setHasChanges(true);
  };

  const handleModelChange = (useCase: string, model: string) => {
    setLocalConfigs((prev) => ({
      ...prev,
      [useCase]: { ...prev[useCase], model },
    }));
    setHasChanges(true);
  };

  const handleSave = () => {
    updateConfigs.mutate(localConfigs);
    setHasChanges(false);
  };

  const useCaseEntries = Object.entries(useCases || {}) as [UseCaseKey, UseCaseInfo][];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">AI Models</h2>
          <p className="text-muted-foreground mt-1">
            Configure which LLM provider and model each system component uses.
          </p>
        </div>
        {hasChanges && (
          <Button
            onClick={handleSave}
            disabled={updateConfigs.isPending}
          >
            {updateConfigs.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin me-2" />
            ) : (
              <Save className="w-4 h-4 me-2" />
            )}
            Save Changes
          </Button>
        )}
      </div>

      <div className="grid gap-6">
        {useCaseEntries.map(([useCaseKey, useCaseInfo]) => {
          const config = localConfigs[useCaseKey];
          if (!config) return null;

          const availableModels = getModelsForUseCase(config.provider, useCaseKey);
          const currentModel = getModelInfo(config.provider, config.model);
          const availableProviders = getAvailableProviders(useCaseKey);

          return (
            <Card key={useCaseKey}>
              <CardHeader>
                <CardTitle>{useCaseInfo.label}</CardTitle>
                <CardDescription>
                  {useCaseInfo.description}
                  {useCaseInfo.requiresLive && (
                    <Badge variant="outline" className="ms-2 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                      Live
                    </Badge>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  {/* Provider selector */}
                  <div className="space-y-2">
                    <label htmlFor={`model-settings-provider-${useCaseKey}`} className="text-sm font-medium">Provider</label>
                    <Select
                      value={config.provider}
                      onValueChange={(v) => handleProviderChange(useCaseKey, v as LLMProviderKey)}
                    >
                      <SelectTrigger id={`model-settings-provider-${useCaseKey}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {availableProviders.map((p) => (
                          <SelectItem key={p} value={p}>
                            {PROVIDER_LABELS[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Model selector */}
                  <div className="space-y-2">
                    <label htmlFor={`model-settings-model-${useCaseKey}`} className="text-sm font-medium">Model</label>
                    <Select
                      value={config.model}
                      onValueChange={(v) => handleModelChange(useCaseKey, v)}
                    >
                      <SelectTrigger id={`model-settings-model-${useCaseKey}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {availableModels.map((m) => (
                          <SelectItem key={m.modelId} value={m.modelId}>
                            {m.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Model info */}
                {currentModel && (
                  <div className="flex items-center gap-3 text-sm text-muted-foreground bg-muted/50 rounded-md p-3">
                    <Badge variant="outline" className={TIER_COLORS[currentModel.tier]}>
                      {currentModel.tier}
                    </Badge>
                    <span>{currentModel.description}</span>
                    <span className="ms-auto text-xs font-mono">
                      ${currentModel.inputCostPer1M}/{currentModel.outputCostPer1M} per 1M tokens
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
