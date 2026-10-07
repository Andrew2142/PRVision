import type { ReactElement, ReactNode } from "react";
import { definePrvisionHarness } from "../harness-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import OrdersPanel from "../../src/features/orders/OrdersPanel";

const CUSTOMER_ID = "cus_1042";
const PAGE_SIZE = 10;

const ORDERS_PAGE = {
  customerName: "Northwind Traders",
  total: 3,
  items: [
    { id: "ord_9001", number: "SO-9001", placedAt: "2024-03-11T14:20:00Z", status: "shipped", total: 1249.5, currency: "USD", itemCount: 4 },
    { id: "ord_9002", number: "SO-9002", placedAt: "2024-03-12T09:05:00Z", status: "processing", total: 89.99, currency: "USD", itemCount: 1 },
    { id: "ord_9003", number: "SO-9003", placedAt: "2024-03-13T17:45:00Z", status: "cancelled", total: 410, currency: "USD", itemCount: 2 },
  ],
} as const;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: Infinity,
      gcTime: Infinity,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    mutations: { retry: false },
  },
});
queryClient.setQueryData(["orders", CUSTOMER_ID, { pageSize: PAGE_SIZE }], ORDERS_PAGE);

const noop = (): void => {};

function Providers({ children }: { children: ReactNode }): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/customers/${CUSTOMER_ID}/orders`]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

export default definePrvisionHarness({
  wrapper: Providers,
  states: [
    {
      name: "Default",
      render: () => (
        <div style={{ padding: 24, width: 1024 }}>
          <Routes>
            <Route
              path="/customers/:customerId/orders"
              element={<OrdersPanel pageSize={PAGE_SIZE} onExport={noop} />}
            />
          </Routes>
        </div>
      ),
    },
  ],
});
