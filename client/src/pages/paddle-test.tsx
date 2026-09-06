import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { usePaddle } from "@/hooks/usePaddle";

interface PaddlePrice {
  id: string;
  description: string;
  amount: string | null;
  currencyCode: string | null;
  status?: string;
}

const TEST_CARDS = [
  { label: "Valid (no 3DS)", number: "4242 4242 4242 4242" },
  { label: "Valid (with 3DS)", number: "4000 0038 0000 0446" },
  { label: "Declined", number: "4000 0000 0000 0002" },
];

function formatAmount(price: PaddlePrice): string {
  if (!price.amount) return "—";
  // Paddle amounts are in the currency's lowest denomination (e.g. cents).
  const major = (Number(price.amount) / 100).toFixed(2);
  return `${major} ${price.currencyCode ?? ""}`.trim();
}

export default function PaddleTest() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [prices, setPrices] = useState<PaddlePrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // paddle-js is initialised once for the whole app; this page just subscribes.
  const { paddle, ready, reason, environment, openCheckoutForPrice } = usePaddle();

  // Debug page — deliberately NOT translated (see CLAUDE.md: debug features are
  // exempt from the i18n rule).
  useEffect(() => {
    if (reason === "no-client-token") {
      toast({
        title: "No client token",
        description:
          "Set PADDLE_CLIENT_TOKEN_TEST (sandbox) or PADDLE_CLIENT_TOKEN (live).",
        variant: "destructive",
      });
    } else if (reason) {
      toast({
        title: "Failed to initialize Paddle",
        description: reason,
        variant: "destructive",
      });
    }
  }, [reason, toast]);

  // Load catalog prices.
  const loadPrices = async () => {
    setLoading(true);
    try {
      const res = await apiRequest("GET", "/api/paddle/prices");
      const data = await res.json();
      setPrices(data.prices ?? []);
    } catch (err) {
      console.error("Error loading prices:", err);
      toast({
        title: "Failed to load prices",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createTestPrice = async () => {
    setCreating(true);
    try {
      await apiRequest("POST", "/api/paddle/test-price");
      await loadPrices();
      toast({ title: "Test price created" });
    } catch (err) {
      console.error("Error creating test price:", err);
      toast({
        title: "Failed to create test price",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const openCheckout = (priceId: string) => {
    if (!ready) {
      toast({
        title: "Paddle not ready",
        description: "Client token missing or still initializing.",
        variant: "destructive",
      });
      return;
    }
    if (!user?.id) {
      toast({
        title: "Not signed in",
        description: "The checkout must carry a userId for the webhook to fulfil it.",
        variant: "destructive",
      });
      return;
    }
    // customData is the ONLY link between a Paddle checkout and our user: the
    // webhook arrives server-to-server with no session, and reads userId from
    // here to decide who gets the credits. Omit it and the event is recorded as
    // `ignored` — the payment succeeds and nothing is granted.
    openCheckoutForPrice(priceId, { userId: user.id }, {
      onCompleted: (transactionId) => {
        toast({
          title: "Checkout completed ✅",
          description: `Transaction ${transactionId ?? ""}`,
        });
      },
    });
  };

  return (
    <div className="container mx-auto p-4 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Paddle Checkout Test</h1>
        <p className="text-muted-foreground">
          Environment:{" "}
          <Badge variant={environment === "production" ? "destructive" : "secondary"}>
            {environment || "…"}
          </Badge>{" "}
          {paddle ? (
            <Badge variant="secondary">paddle-js ready</Badge>
          ) : (
            <Badge variant="outline">initializing…</Badge>
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Test cards</CardTitle>
          <CardDescription>
            Use any future expiry and CVC 100.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {TEST_CARDS.map((c) => (
            <div key={c.number} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{c.label}</span>
              <code>{c.number}</code>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Prices</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={createTestPrice}
          disabled={creating}
        >
          {creating ? "Creating…" : "Create test price ($9.99)"}
        </Button>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading prices…</p>
      ) : prices.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground">
            No prices yet. Click “Create test price” above.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {prices.map((price) => (
            <Card key={price.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div>
                  <p className="font-medium">{price.description}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatAmount(price)} · <code>{price.id}</code>
                  </p>
                </div>
                <Button onClick={() => openCheckout(price.id)} disabled={!paddle}>
                  Checkout
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
