import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import { useUser } from "@clerk/clerk-react";
import { formatMoney, useApi } from "../lib/api";
import type { Booking } from "../types/Event";

const TicketPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const api = useApi();
  const { user } = useUser();
  const [bookingData, setBookingData] = useState<Booking | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  useEffect(() => {
    const fetchBookingData = async () => {
      try {
        // Owner-scoped: another user's booking id returns "not found".
        setBookingData(await api<Booking>(`/me/bookings/${encodeURIComponent(id ?? "")}`));
      } catch (error) {
        setError(error instanceof Error ? error.message : "An error occurred.");
      } finally {
        setLoading(false);
      }
    };

    if (id) {
      fetchBookingData();
    }
  }, [id, api]);

  const handleDeleteTicket = async () => {
    if (!bookingData) return;

    setDeleting(true);
    try {
      await api<Booking>(`/me/bookings/${bookingData.id}/cancel`, { method: "POST" });
      alert("Ticket successfully canceled.");
      navigate("/events");
    } catch (error) {
      setError(error instanceof Error ? error.message : "An error occurred.");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-xl">
      <div className="flex flex-col items-center">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-white text-lg mt-3">Processing...</p>
      </div>
    </div>
  );
  if (error) return <div className="text-red-500 text-center mt-10">{error}</div>;
  if (!bookingData) return <div className="text-center mt-10">No booking data found</div>;

  const ticketCount = bookingData.items.reduce((sum, i) => sum + i.quantity, 0);
  const validTickets = bookingData.tickets.filter((t) => t.status === "VALID");
  const cancellable = ["PENDING", "CONFIRMED"].includes(bookingData.status);

  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100 p-4">
      <div className="relative w-[420px] bg-white shadow-lg rounded-lg overflow-hidden border border-gray-300">
        {/* Ticket Header */}
        <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white text-center py-4">
          <h3 className="text-2xl font-bold uppercase">{bookingData.event?.title}</h3>
          <p className="text-sm">{bookingData.event ? new Date(bookingData.event.startsAt).toLocaleString() : ""}</p>
        </div>

        {/* Ticket Body */}
        <div className="flex flex-col md:flex-row p-5 border-b border-gray-300">
          {/* Left Section */}
          <div className="flex-1 pr-4 border-r border-dashed border-gray-400">
            <p className="text-gray-700 text-sm">
              <strong>Venue:</strong> {bookingData.event?.venueName ?? bookingData.event?.city}
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Status:</strong> {bookingData.status}
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Tickets Reserved:</strong> {ticketCount}
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Total Amount:</strong> {formatMoney(bookingData.totalMinor, bookingData.currency)}
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Customer:</strong> {user?.fullName}
            </p>
          </div>

          {/* Right Section (QR codes: one per ticket, encoding the ticket's random code) */}
          <div className="flex flex-col justify-center items-center gap-2 pl-4">
            {validTickets.length === 0 ? (
              <p className="text-xs text-gray-500 text-center">No valid tickets</p>
            ) : (
              validTickets.map((t) => <QRCodeCanvas key={t.id} value={t.code} size={80} />)
            )}
          </div>
        </div>

        {/* Barcode & Branding */}
        <div className="flex justify-between items-center px-5 py-3 bg-gray-200 border-t border-gray-300">
          <div className="text-xs text-gray-500">Powered by TheEvent</div>
          <div className="h-8 w-36 bg-gray-700 rounded-md"></div>
        </div>

        {/* Buttons */}
        <div className="p-4 flex flex-col gap-3">
          <button
            onClick={() => navigate("/events")}
            className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition"
          >
            Go Back to Events
          </button>

          {cancellable && (
            <button
              onClick={handleDeleteTicket}
              disabled={deleting}
              className="w-full py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition disabled:opacity-50"
            >
              {deleting ? "Cancelling..." : "Cancel Ticket"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default TicketPage;
