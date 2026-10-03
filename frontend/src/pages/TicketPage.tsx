import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";


// Shape of the /event/:id/bookedOne response fields this page reads
interface BookingDetails {
  id: string;
  quantity: number;
  totalAmount: number;
  event: {
    title: string;
    date: string;
    venue: string;
    price?: number | null;
  };
  user: {
    name?: string | null;
  };
}

const TicketPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [bookingData, setBookingData] = useState<BookingDetails | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);
  const API_URL = import.meta.env.VITE_REACT_APP_API_KEY;

  useEffect(() => {
    const fetchBookingData = async () => {
      try {
        const response = await fetch(`${API_URL}/event/${id}/bookedOne`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("jwt")}`,
          },
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to fetch booking details");
        }

        const data = await response.json();
        setBookingData(data);
      } catch (error) {
        console.error(error);
        setError(error instanceof Error ? error.message : "An error occurred.");
      } finally {
        setLoading(false);
      }
    };

    if (id) {
      fetchBookingData();
    }
  }, [id]);

  const handleDeleteTicket = async () => {
    if (!bookingData) return;

    setDeleting(true);
    try {
      const response = await fetch(`${API_URL}/event/${bookingData.id}/cancelTicket/`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("jwt")}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete the ticket");
      }

      alert("Ticket successfully canceled.");
      navigate("/events");
    } catch (error) {
      console.error(error);
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

  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100 p-4">
      <div className="relative w-[420px] bg-white shadow-lg rounded-lg overflow-hidden border border-gray-300">
        {/* Ticket Header */}
        <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white text-center py-4">
          <h3 className="text-2xl font-bold uppercase">{bookingData.event?.title}</h3>
          <p className="text-sm">{new Date(bookingData.event?.date).toLocaleString()}</p>
        </div>

        {/* Ticket Body */}
        <div className="flex flex-col md:flex-row p-5 border-b border-gray-300">
          {/* Left Section */}
          <div className="flex-1 pr-4 border-r border-dashed border-gray-400">
            <p className="text-gray-700 text-sm">
              <strong>Venue:</strong> {bookingData.event?.venue}
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Price:</strong> {bookingData.event?.price || "Free Entry"}
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Tickets Reserved:</strong> {bookingData.quantity}
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Total Amount:</strong> ${bookingData.totalAmount}
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Customer:</strong> {bookingData.user?.name}
            </p>
          </div>

          {/* Right Section (QR Code) */}
          <div className="flex justify-center items-center">
            <QRCodeCanvas value={`${API_URL}/event/${id}/bookedOne`} size={80} />
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

          <button
            onClick={handleDeleteTicket}
            disabled={deleting}
            className="w-full py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition disabled:opacity-50"
          >
            {deleting ? "Cancelling..." : "Cancel Ticket"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TicketPage;
