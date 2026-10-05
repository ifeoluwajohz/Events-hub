import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useClerk, useUser } from "@clerk/clerk-react";
import { Event } from "../types/Event";
import { ApiError, formatMoney, newIdempotencyKey, useApi } from "../lib/api";
import type { Booking } from "../types/Event";

interface OrderButtonProps {
  event: Event;
}

const OrderButton: React.FC<OrderButtonProps> = ({ event }) => {
  const { isSignedIn } = useUser();
  const { openSignIn } = useClerk();
  const api = useApi();
  const navigate = useNavigate();
  const [ticketTypeId, setTicketTypeId] = useState(event.ticketTypes[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // One key per intended booking: retries/double clicks cannot create a second booking.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const ticketType = useMemo(() => event.ticketTypes.find((t) => t.id === ticketTypeId), [event, ticketTypeId]);
  const maxQuantity = ticketType ? Math.min(ticketType.remaining, ticketType.maxPerOrder) : 0;
  const isEventStarted = new Date(event.startsAt).getTime() < Date.now();
  const isSoldOut = !ticketType || ticketType.soldOut;
  const isPaid = Boolean(ticketType && !ticketType.isFree);
  const unavailable = event.status !== "PUBLISHED" || isEventStarted || isSoldOut || isPaid;

  const changeQuantity = (next: number) => {
    setQuantity(Math.max(1, Math.min(next, maxQuantity || 1)));
    setIdempotencyKey(newIdempotencyKey());
  };

  const handleReserve = async () => {
    if (unavailable || !ticketType) return;
    if (!isSignedIn) {
      openSignIn();
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const booking = await api<Booking>("/me/bookings", {
        method: "POST",
        body: { eventId: event.id, items: [{ ticketTypeId: ticketType.id, quantity }], idempotencyKey },
      });
      setMessage(`Successfully reserved ${quantity} ticket(s)!`);
      navigate(`/ticket/${booking.id}`);
    } catch (error) {
      setMessage(error instanceof ApiError || error instanceof Error ? error.message : "An error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const label =
    event.status === "CANCELLED" ? "Event Cancelled"
    : isEventStarted ? "Event Started"
    : isSoldOut ? "Sold Out"
    : isPaid ? "Paid tickets coming soon"
    : loading ? "Processing..."
    : "Reserve a Spot";

  return (
    <div className="p-4 rounded-md w-full bg-gray-50">
      <div className="p-4 mb-4 rounded-md bg-slate-200 shadow-md">
        {event.ticketTypes.length > 1 ? (
          <select
            aria-label="Ticket type"
            value={ticketTypeId}
            onChange={(e) => {
              setTicketTypeId(e.target.value);
              setQuantity(1);
              setIdempotencyKey(newIdempotencyKey());
            }}
            className="mb-2 px-2 py-1 rounded-md border border-gray-300"
          >
            {event.ticketTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : (
          <h3 className="text-lg font-semibold text-gray-800">{ticketType?.name ?? "Tickets"}</h3>
        )}
        <span className="block font-medium text-gray-600">
          Price: {ticketType ? (ticketType.isFree ? "Free Entry" : formatMoney(ticketType.priceMinor, event.currency)) : "—"}
        </span>
      </div>

      {/* Quantity Selector */}
      <div className="flex items-center mb-4">
        <button
          className="px-3 py-1 bg-gray-200 text-gray-700 rounded-l-md focus:outline-none hover:bg-gray-300 disabled:opacity-50"
          onClick={() => changeQuantity(quantity - 1)}
          disabled={quantity === 1}
          aria-label="Decrease quantity"
        >
          -
        </button>
        <span className="px-4 py-1 border-t border-b">{quantity}</span>
        <button
          className="px-3 py-1 bg-gray-200 text-gray-700 rounded-r-md focus:outline-none hover:bg-gray-300 disabled:opacity-50"
          onClick={() => changeQuantity(quantity + 1)}
          disabled={quantity >= maxQuantity}
          aria-label="Increase quantity"
        >
          +
        </button>
      </div>

      {/* Reserve Button */}
      <button
        onClick={handleReserve}
        disabled={loading || unavailable}
        className={`w-full py-2 font-semibold rounded-md focus:outline-none ${
          loading || unavailable ? "bg-gray-400 text-gray-200 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"
        }`}
      >
        {label}
      </button>

      {/* Status Message */}
      {message && (
        <div className={`mt-4 p-2 text-sm rounded-md ${message.startsWith("Successfully") ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
          {message}
        </div>
      )}
    </div>
  );
};

export default OrderButton;
