import { useState, useEffect } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';

// Initialize Stripe
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY!);

interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  price: number;
  bonusCredits: number;
  isActive: boolean;
  sortOrder: number;
}

const CheckoutForm = ({ selectedPackage, onSuccess }: { selectedPackage: CreditPackage; onSuccess: () => void }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!stripe || !elements) return;

    setIsProcessing(true);

    try {
      // Create payment intent
      const response = await fetch('/api/create-payment-intent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ packageId: selectedPackage.id }),
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || 'Failed to create payment intent');
      }

      // Confirm payment
      const { error, paymentIntent } = await stripe.confirmCardPayment(data.clientSecret, {
        payment_method: {
          card: elements.getElement(CardElement)!,
        }
      });

      if (error) {
        throw new Error(error.message);
      }

      if (paymentIntent?.status === 'succeeded') {
        // Confirm payment on backend and add credits
        const confirmResponse = await fetch('/api/confirm-payment', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ paymentIntentId: paymentIntent.id }),
        });

        const confirmData = await confirmResponse.json();

        if (!confirmResponse.ok) {
          throw new Error(confirmData.message || 'Failed to confirm payment');
        }

        alert(`הצלחה! ${selectedPackage.credits + selectedPackage.bonusCredits} נקודות זכות נוספו לחשבונך`);
        onSuccess();
      }
    } catch (error) {
      console.error('Payment error:', error);
      alert(`שגיאה בתשלום: ${error.message || 'אירעה שגיאה בעת עיבוד התשלום'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="p-4 border rounded-lg bg-muted/50">
        <h3 className="font-semibold text-lg mb-2">{selectedPackage.name}</h3>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl font-bold text-primary">{selectedPackage.credits}</span>
          <span className="text-muted-foreground">נקודות זכות</span>
          {selectedPackage.bonusCredits > 0 && (
            <Badge variant="secondary">+ {selectedPackage.bonusCredits} בונוס</Badge>
          )}
        </div>
        <p className="text-xl font-semibold">${selectedPackage.price}</p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">פרטי כרטיס אשראי</label>
          <div className="p-3 border rounded-md">
            <CardElement
              options={{
                style: {
                  base: {
                    fontSize: '16px',
                    color: '#424770',
                    '::placeholder': {
                      color: '#aab7c4',
                    },
                  },
                },
              }}
            />
          </div>
        </div>
      </div>

      <Button 
        type="submit" 
        disabled={!stripe || isProcessing}
        className="w-full"
      >
        {isProcessing ? "מעבד..." : `שלם $${selectedPackage.price}`}
      </Button>
    </form>
  );
};

export default function PurchaseCredits() {
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [selectedPackage, setSelectedPackage] = useState<CreditPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    fetchCreditPackages();
  }, []);

  const fetchCreditPackages = async () => {
    try {
      const response = await apiRequest('GET', '/api/credit-packages');
      setPackages(response.packages || []);
    } catch (error) {
      console.error('Error fetching credit packages:', error);
      toast({
        title: "שגיאה",
        description: "לא ניתן לטעון את חבילות הנקודות",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSuccess = () => {
    setSelectedPackage(null);
  };

  if (loading) {
    return (
      <div className="container mx-auto p-4 max-w-4xl">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  if (selectedPackage) {
    return (
      <div className="container mx-auto p-4 max-w-2xl">
        <div className="mb-6">
          <Button 
            variant="ghost" 
            onClick={() => setSelectedPackage(null)}
            className="mb-4"
          >
            ← חזור לחבילות
          </Button>
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold mb-2">השלמת רכישה</h1>
            <p className="text-muted-foreground">
              יתרה נוכחית: <span className="font-semibold">{user?.credits || 0}</span> נקודות זכות
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>פרטי תשלום</CardTitle>
            <CardDescription>
              התשלום מאובטח באמצעות Stripe
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Elements stripe={stripePromise}>
              <CheckoutForm 
                selectedPackage={selectedPackage} 
                onSuccess={handleSuccess} 
              />
            </Elements>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 max-w-4xl">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-4">רכישת נקודות זכות</h1>
        <p className="text-lg text-muted-foreground mb-2">
          בחר את החבילה המתאימה לך
        </p>
        <p className="text-sm text-muted-foreground">
          יתרה נוכחית: <span className="font-semibold text-primary">{user?.credits || 0}</span> נקודות זכות
        </p>
      </div>

      {packages.length === 0 ? (
        <Card>
          <CardContent className="text-center py-8">
            <p className="text-muted-foreground">אין חבילות זמינות כרגע</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {packages.map((pkg) => (
            <Card 
              key={pkg.id}
              className="relative hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => setSelectedPackage(pkg)}
            >
              <CardHeader className="text-center">
                <CardTitle className="text-xl">{pkg.name}</CardTitle>
                <div className="space-y-2">
                  <div className="text-3xl font-bold text-primary">
                    {pkg.credits}
                  </div>
                  <div className="text-sm text-muted-foreground">נקודות זכות</div>
                  {pkg.bonusCredits > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      + {pkg.bonusCredits} בונוס
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="text-center">
                <div className="text-2xl font-bold mb-4">${pkg.price}</div>
                <Button className="w-full">בחר חבילה</Button>
                {pkg.bonusCredits > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    סה״כ: {pkg.credits + pkg.bonusCredits} נקודות
                  </p>
                )}
              </CardContent>
              {pkg.bonusCredits > 0 && (
                <div className="absolute -top-3 -right-3">
                  <Badge className="bg-green-500 hover:bg-green-600 text-white">
                    הטבה!
                  </Badge>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}