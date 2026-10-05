import React, { useEffect, useState } from "react";
import { useUser } from "@clerk/clerk-react";
import { useNavigate, Link } from "react-router-dom";
import { useApi } from "../lib/api";
import type { Booking } from "../types/Event";

// "Delete all tickets" was removed in Phase 2B: bulk-deleting booking history is not a
// feature (and the old endpoint deleted anyone's bookings). Cancel from each ticket page.
const Events: React.FC = () => {
  const { isSignedIn } = useUser();
  const api = useApi();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isSignedIn) return;
    api<Booking[]>("/me/bookings?limit=100")
      .then(setBookings)
      .catch((err: Error) => setError(err.message));
  }, [isSignedIn, api]);

  if (error) return <div className="text-center text-red-500 py-10">{error}</div>;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-800 text-center mb-10">
        Your Booked Events
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {bookings.filter((b) => b.event).map((booking) => (
          <div
            key={booking.id}
            className="bg-white shadow-lg rounded-lg hover:shadow-xl transition duration-300 cursor-pointer"
            onClick={() => navigate(`/event/${booking.event!.id}`)} // Navigate to event details on card click
          >
            {booking.event!.coverImageUrl && (
              <img
                src={booking.event!.coverImageUrl}
                alt={booking.event!.title}
                className="w-full h-48 object-cover rounded-t-lg"
              />
            )}
            <div className="p-4">
              <h2 className="text-xl font-semibold text-gray-800 mb-2">
                {booking.event!.title}
              </h2>
              <p className="text-sm text-gray-600 mb-2">
                {new Date(booking.event!.startsAt).toLocaleDateString()} at {booking.event!.venueName ?? booking.event!.city}
              </p>
              <p className="text-sm text-gray-600 truncate">{booking.event!.summary}</p>
              <p className="text-xs text-gray-500 mt-1">{booking.status}</p>
              <div className="mt-4 flex justify-between items-center">
                {/* View Ticket Button */}
                <Link
                  to={`/ticket/${booking.id}`} // Link to ticket details
                  className="text-blue-500 hover:underline"
                  onClick={(e) => e.stopPropagation()} // Prevent card click event
                >
                  View Ticket
                </Link>
                <button
                  className="text-sm text-blue-500 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/event/${booking.event!.id}`);
                  }}
                >
                  View Details
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Events;
