// src/components/admin/CrmAdminPage.tsx
// Top-level CRM admin section: tabs for Customers (list) and Settings.

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CrmCustomerList } from "./CrmCustomerList";
import { CrmSettings } from "./CrmSettings";

export function CrmAdminPage() {
  return (
    <Tabs defaultValue="customers" className="space-y-6">
      <TabsList>
        <TabsTrigger value="customers" data-testid="crm-tab-customers">
          Customers
        </TabsTrigger>
        <TabsTrigger value="settings" data-testid="crm-tab-settings">
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="customers">
        <CrmCustomerList />
      </TabsContent>
      <TabsContent value="settings">
        <CrmSettings />
      </TabsContent>
    </Tabs>
  );
}
