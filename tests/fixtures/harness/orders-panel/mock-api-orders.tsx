const ORDERS_PAGE = {
  customerName: "Northwind Traders",
  total: 3,
  items: [
    { id: "ord_9001", number: "SO-9001", placedAt: "2024-03-11T14:20:00Z", status: "shipped", total: 1249.5, currency: "USD", itemCount: 4 },
    { id: "ord_9002", number: "SO-9002", placedAt: "2024-03-12T09:05:00Z", status: "processing", total: 89.99, currency: "USD", itemCount: 1 },
    { id: "ord_9003", number: "SO-9003", placedAt: "2024-03-13T17:45:00Z", status: "cancelled", total: 410, currency: "USD", itemCount: 2 },
  ],
};

export async function fetchOrders(_customerId: string, _options?: { pageSize?: number }): Promise<typeof ORDERS_PAGE> {
  return ORDERS_PAGE;
}

export async function fetchOrder(orderId: string): Promise<(typeof ORDERS_PAGE.items)[number] | undefined> {
  return ORDERS_PAGE.items.find((order) => order.id === orderId);
}

export async function cancelOrder(_orderId: string): Promise<void> {
  return undefined;
}
