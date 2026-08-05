import { useMemo, useState } from "react";
import { CheckoutState } from "../shared/CheckoutState";
import { useInvoice } from "../shared/useInvoice";

export function App() {
  const invoiceId = useMemo(() => {
    const match = window.location.pathname.match(/\/pay\/([^/]+)\/?$/);
    return match?.[1] ?? "";
  }, []);

  const { invoice, notFound } = useInvoice(invoiceId);
  const [simulateBusy, setSimulateBusy] = useState(false);

  const onSimulate = async () => {
    setSimulateBusy(true);
    try {
      await fetch(`/dev/pay/${invoiceId}`, { method: "POST" });
      // No state handling needed: the resulting transition arrives over SSE.
    } finally {
      setSimulateBusy(false);
    }
  };

  return (
    <div className="page">
      <CheckoutState
        invoice={invoice}
        notFound={notFound}
        onSimulate={() => void onSimulate()}
        simulateBusy={simulateBusy}
      />
    </div>
  );
}
