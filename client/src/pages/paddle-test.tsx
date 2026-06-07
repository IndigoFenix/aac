import { useEffect, useState } from "react";
import {
  initializePaddle,
  CheckoutEventNames,
  type Paddle,
} from "@paddle/paddle-js";
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
import { apiRequest } from "@/lib/queryClient";

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
  const [paddle, setPaddle] = useState<Paddle | null>(null);
  const [environment, setEnvironment] = useState<string>("");
  const [prices, setPrices] = useState<PaddlePrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Initialize paddle-js from server-provided config.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/paddle/config");
        const cfg = await res.json();
        if (cancelled) return;
        setEnvironment(cfg.environment);
        if (!cfg.clientToken) {
          toast({
            title: "No client token",
            description:
              "Set PADDLE_CLIENT_TOKEN_TEST (sandbox) or PADDLE_CLIENT_TOKEN (live).",
            variant: "destructive",
          });
          return;
        }
        const instance = await initializePaddle({
          environment: cfg.environment === "production" ? "production" : "sandbox",
          token: cfg.clientToken,
          eventCallback: (event) => {
            if (event.name === CheckoutEventNames.CHECKOUT_COMPLETED) {
              toast({
                title: "Checkout completed ✅",
                description: `Transaction ${event.data?.transaction_id ?? ""}`,
              });
            }
          },
        });
        if (!cancelled && instance) setPaddle(instance);
      } catch (err) {
        console.error("Paddle init error:", err);
        toast({
          title: "Failed to initialize Paddle",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

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
    if (!paddle) {
      toast({
        title: "Paddle not ready",
        description: "Client token missing or still initializing.",
        variant: "destructive",
      });
      return;
    }
    paddle.Checkout.open({ items: [{ priceId, quantity: 1 }] });
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
