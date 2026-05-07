import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { format } from "date-fns";

interface ChatLogProps {
  isOpen: boolean;
  onClose: () => void;
  studentId: string | null;
}

export default function ChatLog({ isOpen, onClose, studentId }: ChatLogProps) {
  // Get chat history
  const { data: chatHistory = [] } = useQuery<any[]>({
    queryKey: ["/api/aac/conversation/history", studentId],
    enabled: !!studentId && isOpen,
  });

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 bg-white z-30"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
        >
          <div className="h-full flex flex-col">
            {/* Header */}
            <div className="bg-primary text-white p-4 flex justify-between items-center">
              <h2 className="text-xl font-semibold">Conversation History</h2>
              <Button
                variant="ghost"
                size="sm"
                className="text-white hover:text-gray-200 hover:bg-white/10"
                onClick={onClose}
                aria-label="Close"
              >
                <X className="h-6 w-6" />
              </Button>
            </div>
            
            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto p-4">
              {chatHistory.length > 0 ? (
                <div className="space-y-3">
                  {chatHistory.map((message: any) => (
                    <motion.div
                      key={message.id}
                      className="bg-gray-100 rounded-lg p-3"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                    >
                      <span className="text-sm text-text-secondary">
                        {format(new Date(message.timestamp), 'h:mm a')}
                      </span>
                      <p className="text-lg text-text-primary mt-1">
                        {Array.isArray(message.symbols) 
                          ? message.symbols.join(' → ') 
                          : 'Communication'}
                      </p>
                      {message.interpretedText && (
                        <p className="text-base text-text-secondary italic mt-1">
                          "{message.interpretedText}"
                        </p>
                      )}
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="text-6xl mb-4">💬</div>
                    <h3 className="text-xl font-semibold text-text-primary mb-2">
                      No conversations yet
                    </h3>
                    <p className="text-text-secondary">
                      Start communicating to see your history here
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
