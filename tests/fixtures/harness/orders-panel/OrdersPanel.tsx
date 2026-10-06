import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { fetchOrders, type Order } from "@/api/orders";
import { formatCurrency, formatDate } from "@/lib/format";
import { OrderStatusBadge } from "./OrderStatusBadge";
import "./OrdersPanel.css";

export interface OrdersPanelProps {
  pageSize?: number;
  onExport?: (orders: Order[]) => void;
}

export default function OrdersPanel({ pageSize = 10, onExport }: OrdersPanelProps) {
  const { customerId = "" } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["orders", customerId, { pageSize }],
    queryFn: () => fetchOrders(customerId, { pageSize }),
  });

  if (isLoading) return <div className="orders-panel__loading">Loading orders…</div>;
  if (isError || !data) return <div className="orders-panel__error">Could not load orders.</div>;

  return (
    <section className="orders-panel">
      <header className="orders-panel__header">
        <h2>Orders for {data.customerName}</h2>
        {hasPermission("orders:export") && (
          <button type="button" onClick={() => onExport?.(data.items)}>Export CSV</button>
        )}
      </header>
      <table className="orders-panel__table">
        <thead><tr><th>Order</th><th>Placed</th><th>Status</th><th>Total</th></tr></thead>
        <tbody>
          {data.items.map((order) => (
            <tr key={order.id}>
              <td><Link to={`/orders/${order.id}`}>{order.number}</Link></td>
              <td>{formatDate(order.placedAt)}</td>
              <td><OrderStatusBadge status={order.status} /></td>
              <td>{formatCurrency(order.total, order.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="orders-panel__footer">
        Signed in as {user.name} · <button type="button" onClick={() => navigate("/orders/new")}>New order</button>
      </footer>
    </section>
  );
}
