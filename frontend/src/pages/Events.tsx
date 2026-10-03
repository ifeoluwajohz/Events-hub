import React, { useEffect, useState } from "react";
import { useUser } from "@clerk/clerk-react"
import { useNavigate } from "react-router-dom";
const API_URL = import.meta.env.VITE_REACT_APP_API_KEY;

interface Booking {
  id: string;
  eventId: string;
  event: Event
}

interface Event {
  id: string;
  title: string;
  shortDescription: string;
  longDescription: string;
  date: string;
  venue: string;
  imageUrl: string;
}

const Events: React.FC = () => {
  const { user } = useUser();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const fetchBookings = async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${API_URL}/event/${user.id}/bookedAll`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("jwt")}`,
          },
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch booking details");
      }

      const data = await response.json();
      setBookings(data);
    } catch (error) {
      setError((error as Error).message);
    }finally {
      setLoading(false);
    }
  };

  const deleteAllBookings = async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);
    const confirmed = window.confirm("Are you sure you want to delete all bookings?");
    if (!confirmed) return;

    try {
      const response = await fetch(
        `${API_URL}/event/${user.id}/bookedDelete`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("jwt")}`,
          },
        }
      );
      console.log(response)
      setBookings([]); // Clear the events after successful deletion
    } catch (error) {
      setError((error as Error).message);
    }finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBookings();
  }, [user]);

  // TODO(phase 2): render a loading state. `loading` currently never resets
  // for signed-out users or when "Delete All" is cancelled, so showing it
  // here would leave a permanent spinner.
  if (error) return <div className="text-center text-red-500 py-10">{error}</div>;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-800 text-center mb-10">
        Your Booked Events
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {bookings.map((booking) => (
          <div
            key={booking.id}
            className="bg-white shadow-lg rounded-lg hover:shadow-xl transition duration-300 cursor-pointer"
            onClick={() => navigate(`/event/${booking.event.id}`)} // Navigate to event details on card click
          >
            <img
              src={booking.event.imageUrl}
              alt={booking.event.title}
              className="w-full h-48 object-cover rounded-t-lg"
            />
            <div className="p-4">
              <h2 className="text-xl font-semibold text-gray-800 mb-2">
                {booking.event.title}
              </h2>
              <p className="text-sm text-gray-600 mb-2">
                {new Date(booking.event.date).toLocaleDateString()} at {booking.event.venue}
              </p>
              <p className="text-sm text-gray-600 truncate">{booking.event.shortDescription}</p>
              <div className="mt-4 flex justify-between items-center">
                {/* View Ticket Button */}
                <a
                  href={`/ticket/${booking.id}`} // Link to ticket details
                  className="text-blue-500 hover:underline"
                  onClick={(e) => e.stopPropagation()} // Prevent card click event
                >
                  View Ticket
                </a>
                <button
                  className="text-sm text-blue-500 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/event/${booking.event.id}`);
                  }}
                >
                  View Details
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={deleteAllBookings}
        className="bg-red-500 text-white px-4 py-2 rounded-md mt-10 block mx-auto hover:bg-red-600 transition duration-300"
      >
        Delete All Tickets?
      </button>
    </div>
  );
};

export default Events;
