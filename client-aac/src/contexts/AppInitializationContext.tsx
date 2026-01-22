import { createContext, useContext, useState, useCallback, useEffect, useMemo, ReactNode } from "react";

export type InitTaskId = 'camera' | 'boards' | 'conversation';
export type InitTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface InitTask {
  id: InitTaskId;
  label: string;
  weight: number;
  status: InitTaskStatus;
  error?: string;
  optional: boolean;
}

interface AppInitializationContextType {
  tasks: Map<InitTaskId, InitTask>;
  progress: number;
  isComplete: boolean;
  currentTaskLabel: string | null;
  hasErrors: boolean;
  startTask: (id: InitTaskId) => void;
  completeTask: (id: InitTaskId) => void;
  failTask: (id: InitTaskId, error: string) => void;
  skipTask: (id: InitTaskId) => void;
  resetInitialization: () => void;
}

const AppInitializationContext = createContext<AppInitializationContextType | undefined>(undefined);

// Task definitions with weights
const TASK_DEFINITIONS: Record<InitTaskId, Omit<InitTask, 'status' | 'error'>> = {
  camera: { id: 'camera', label: 'Setting up camera...', weight: 30, optional: true },
  boards: { id: 'boards', label: 'Loading boards...', weight: 35, optional: true },
  conversation: { id: 'conversation', label: 'Connecting to AI...', weight: 35, optional: true },
};

function createInitialTasks(): Map<InitTaskId, InitTask> {
  const tasks = new Map<InitTaskId, InitTask>();
  for (const [id, def] of Object.entries(TASK_DEFINITIONS)) {
    // Camera is skipped immediately - CameraProvider is not used (useMultiCamera is used instead)
    // Conversation is skipped immediately - it initializes when ConversationBox becomes visible
    const status = (id === 'camera' || id === 'conversation') ? 'skipped' : 'pending';
    tasks.set(id as InitTaskId, { ...def, status });
  }
  return tasks;
}

function calculateProgress(tasks: Map<InitTaskId, InitTask>): number {
  let completedWeight = 0;
  let totalWeight = 0;

  for (const task of tasks.values()) {
    totalWeight += task.weight;
    if (task.status === 'completed' || task.status === 'skipped') {
      completedWeight += task.weight;
    } else if (task.status === 'failed' && task.optional) {
      // Failed optional tasks contribute 50% weight (degraded but functional)
      completedWeight += task.weight * 0.5;
    }
  }

  return totalWeight > 0 ? (completedWeight / totalWeight) * 100 : 0;
}

function getCurrentTaskLabel(tasks: Map<InitTaskId, InitTask>): string | null {
  for (const task of tasks.values()) {
    if (task.status === 'in_progress') {
      return task.label;
    }
  }
  return null;
}

function checkIsComplete(tasks: Map<InitTaskId, InitTask>): boolean {
  for (const task of tasks.values()) {
    if (task.status === 'pending' || task.status === 'in_progress') {
      return false;
    }
    // Non-optional tasks that failed mean not complete
    if (task.status === 'failed' && !task.optional) {
      return false;
    }
  }
  return true;
}

function checkHasErrors(tasks: Map<InitTaskId, InitTask>): boolean {
  for (const task of tasks.values()) {
    if (task.status === 'failed') {
      return true;
    }
  }
  return false;
}

interface AppInitializationProviderProps {
  children: ReactNode;
  minDisplayTime?: number; // Minimum time to show loading (prevents jarring flash)
}

export function AppInitializationProvider({
  children,
  minDisplayTime = 2000
}: AppInitializationProviderProps) {
  const [tasks, setTasks] = useState<Map<InitTaskId, InitTask>>(createInitialTasks);
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);

  // Enforce minimum display time
  useEffect(() => {
    const timer = setTimeout(() => {
      setMinTimeElapsed(true);
    }, minDisplayTime);
    return () => clearTimeout(timer);
  }, [minDisplayTime]);

  // Fallback: auto-skip any tasks still pending after 5 seconds
  useEffect(() => {
    const fallbackTimer = setTimeout(() => {
      setTasks(prev => {
        const newTasks = new Map(prev);
        for (const [id, task] of newTasks) {
          if (task.status === 'pending' || task.status === 'in_progress') {
            console.log(`[AppInit] Fallback: skipping stuck task "${id}"`);
            newTasks.set(id, { ...task, status: 'skipped' });
          }
        }
        return newTasks;
      });
    }, 5000);
    return () => clearTimeout(fallbackTimer);
  }, []);

  const startTask = useCallback((id: InitTaskId) => {
    setTasks(prev => {
      const newTasks = new Map(prev);
      const task = newTasks.get(id);
      if (task && task.status === 'pending') {
        newTasks.set(id, { ...task, status: 'in_progress' });
      }
      return newTasks;
    });
  }, []);

  const completeTask = useCallback((id: InitTaskId) => {
    setTasks(prev => {
      const newTasks = new Map(prev);
      const task = newTasks.get(id);
      if (task) {
        newTasks.set(id, { ...task, status: 'completed', error: undefined });
      }
      return newTasks;
    });
  }, []);

  const failTask = useCallback((id: InitTaskId, error: string) => {
    setTasks(prev => {
      const newTasks = new Map(prev);
      const task = newTasks.get(id);
      if (task) {
        newTasks.set(id, { ...task, status: 'failed', error });
      }
      return newTasks;
    });
  }, []);

  const skipTask = useCallback((id: InitTaskId) => {
    setTasks(prev => {
      const newTasks = new Map(prev);
      const task = newTasks.get(id);
      if (task) {
        newTasks.set(id, { ...task, status: 'skipped', error: undefined });
      }
      return newTasks;
    });
  }, []);

  const resetInitialization = useCallback(() => {
    setTasks(createInitialTasks());
    setMinTimeElapsed(false);
    // Restart the minimum display timer
    setTimeout(() => setMinTimeElapsed(true), minDisplayTime);
  }, [minDisplayTime]);

  const progress = calculateProgress(tasks);
  const tasksComplete = checkIsComplete(tasks);
  const isComplete = tasksComplete && minTimeElapsed;
  const currentTaskLabel = getCurrentTaskLabel(tasks);
  const hasErrors = checkHasErrors(tasks);

  // Memoize the context value to prevent unnecessary re-renders
  const value = useMemo<AppInitializationContextType>(() => ({
    tasks,
    progress,
    isComplete,
    currentTaskLabel,
    hasErrors,
    startTask,
    completeTask,
    failTask,
    skipTask,
    resetInitialization,
  }), [tasks, progress, isComplete, currentTaskLabel, hasErrors, startTask, completeTask, failTask, skipTask, resetInitialization]);

  return (
    <AppInitializationContext.Provider value={value}>
      {children}
    </AppInitializationContext.Provider>
  );
}

export function useAppInitialization(): AppInitializationContextType {
  const context = useContext(AppInitializationContext);
  if (context === undefined) {
    throw new Error('useAppInitialization must be used within an AppInitializationProvider');
  }
  return context;
}

// Optional version that returns null if not inside provider (for use by child contexts)
export function useAppInitializationOptional(): AppInitializationContextType | null {
  return useContext(AppInitializationContext) ?? null;
}
