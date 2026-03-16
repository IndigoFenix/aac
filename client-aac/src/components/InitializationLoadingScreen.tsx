import { motion } from "framer-motion";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppInitialization } from "@/contexts/AppInitializationContext";
import axolotlLogo from "@assets/axolotl-logo.png";

export default function InitializationLoadingScreen() {
  const {
    progress,
    currentTaskLabel,
    hasErrors,
    tasks,
    resetInitialization,
  } = useAppInitialization();

  // Collect failed tasks for display
  const failedTasks = Array.from(tasks.values()).filter(t => t.status === 'failed');

  return (
    <div className="h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-blue-900 flex items-center justify-center">
      <div className="text-center space-y-8 max-w-lg mx-auto p-8">
        {/* Animated Logo/Icon */}
        <motion.div
          className="relative mx-auto w-24 h-24"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 1 }}
        >
          <motion.div
            className="absolute inset-0 bg-gradient-to-r from-purple-500 to-violet-600 rounded-full"
            animate={{
              rotate: 360,
              scale: [1, 1.1, 1]
            }}
            transition={{
              rotate: { duration: 3, repeat: Infinity, ease: "linear" },
              scale: { duration: 2, repeat: Infinity, ease: "easeInOut" }
            }}
          />
          <div className="absolute inset-2 bg-white dark:bg-gray-900 rounded-full flex items-center justify-center">
            <img src={axolotlLogo} alt="Aivota" className="w-12 h-12 object-contain" />
          </div>
        </motion.div>

        {/* System Name and Loading Text */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.8 }}
          className="space-y-4"
        >
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
            Aivota
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            Advanced Communication Platform
          </p>
        </motion.div>

        {/* Loading Progress Animation */}
        <motion.div
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 1, duration: 0.8 }}
          className="space-y-4"
        >
          {/* Current Task or Error Status */}
          {hasErrors && failedTasks.length > 0 ? (
            <div className="space-y-2">
              {failedTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-center gap-2 text-amber-600 dark:text-amber-400"
                >
                  <AlertTriangle className="w-4 h-4" />
                  <span className="text-sm">
                    {task.id === 'camera' && 'Camera unavailable'}
                    {task.id === 'boards' && 'Boards unavailable'}
                    {task.id === 'conversation' && 'Chat unavailable'}
                  </span>
                </div>
              ))}
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Some features may be limited
              </p>
            </div>
          ) : currentTaskLabel ? (
            <>
              <div className="flex items-center justify-center space-x-2 text-gray-500 dark:text-gray-400">
                <motion.div
                  className="w-2 h-2 bg-blue-500 rounded-full"
                  animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity, delay: 0 }}
                />
                <motion.div
                  className="w-2 h-2 bg-blue-500 rounded-full"
                  animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity, delay: 0.3 }}
                />
                <motion.div
                  className="w-2 h-2 bg-blue-500 rounded-full"
                  animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity, delay: 0.6 }}
                />
              </div>

              <motion.p
                className="text-sm text-gray-500 dark:text-gray-400"
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                {currentTaskLabel}
              </motion.p>
            </>
          ) : (
            <motion.p
              className="text-sm text-gray-500 dark:text-gray-400"
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              Initializing...
            </motion.p>
          )}
        </motion.div>

        {/* Progress Bar */}
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: "100%", opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.5 }}
          className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden"
        >
          <motion.div
            className="h-full bg-gradient-to-r from-blue-500 to-indigo-600 rounded-full"
            initial={{ width: "0%" }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          />
        </motion.div>

        {/* Progress Percentage */}
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {Math.round(progress)}%
        </p>

        {/* Retry Button - shown when all tasks complete with errors */}
        {hasErrors && progress >= 100 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <Button
              onClick={resetInitialization}
              variant="outline"
              className="gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Retry
            </Button>
          </motion.div>
        )}
      </div>
    </div>
  );
}
