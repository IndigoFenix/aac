import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { User } from "lucide-react";

export function TopHeader() {
  return (
    <div className="h-16 border-b border-border bg-background px-6 flex items-center justify-end">
      <div className="flex items-center gap-3" data-testid="header-profile">
        <div className="text-right">
          <p className="text-sm font-medium text-foreground">SLPPro</p>
          <div className="flex items-center gap-2 justify-end">
            <div className="w-2 h-2 rounded-full bg-status-online" data-testid="status-online" />
            <p className="text-xs text-muted-foreground">Active</p>
          </div>
        </div>
        <Avatar className="w-9 h-9">
          <AvatarFallback className="bg-primary/10">
            <User className="w-4 h-4 text-primary" />
          </AvatarFallback>
        </Avatar>
      </div>
    </div>
  );
}
