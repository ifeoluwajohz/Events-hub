import React, { useEffect, useState } from "react";
import { FaRegCalendarTimes } from "react-icons/fa";

import { useParams, Link } from "react-router-dom";
import { publicApi } from "../lib/api";
import type { Event } from "../types/Event";

const EventsPage: React.FC = () => {
  const { location } = useParams<{ location: string }>();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [eventsPerPage] = useState<number>(5); // Number of events per page

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        setEvents(await publicApi<Event[]>(`/public/events?location=${encodeURIComponent(location ?? "")}&limit=100`));
      } catch (error) {
        console.error("Error fetching events:", error);
        setEvents([]);
      } finally {
        setLoading(false);
      }
    };

    fetchEvents();
  }, [location]);

  // Calculate the current events to display
  const indexOfLastEvent = currentPage * eventsPerPage;
  const indexOfFirstEvent = indexOfLastEvent - eventsPerPage;
  const currentEvents = events.slice(indexOfFirstEvent, indexOfLastEvent);

  // Calculate total pages
  const totalPages = Math.ceil(events.length / eventsPerPage);

  // Pagination handlers
  const goToPage = (page: number) => setCurrentPage(page);
  const nextPage = () => setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  const prevPage = () => setCurrentPage((prev) => Math.max(prev - 1, 1));

  return (
    <div className="max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8 py-12 bg-gray-50">
      {/* Page Header */}
      <header className="text-center mb-12 mt-4">
        <h1 className="text-3xl font-bold text-gray-800">
          Discover Events in <span className="text-blue-600">{location}</span>
        </h1>
        <p className="mt-2 text-gray-600 text-sm">
          Find the best events curated just for you. Explore by date, venue, and type.
        </p>
      </header>

      {/* Loading State */}
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-xl">
          <div className="flex flex-col items-center">
            <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-white text-lg mt-3">Processing...</p>
          </div>
        </div>
      ) : currentEvents.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center">
        <div className=" text-center my-20 flex flex-col items-center">
          <FaRegCalendarTimes className="text-4xl text-gray-400 mb-4" />
          <p className="text-sm text-gray-600">No events found in this location.</p>
        </div>
        </div>
      ) : (
        <>
          <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {currentEvents.map((event) => (
              <Link
                to={`/event/${event.id}`}
                key={event.id}
                className="group block bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow overflow-hidden"
              >
                {/* Event Image */}
                <div className="relative h-48 sm:h-56 md:h-64 lg:h-72 overflow-hidden">
                  <img
                    src={event.coverImageUrl || "/images/event-placeholder.jpg"}
                    alt={event.title}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent"></div>
                  <div className="absolute bottom-3 left-4 text-white">
                    <h3 className="text-xl font-bold">{event.title}</h3>
                    <p className="text-sm">{new Date(event.startsAt).toDateString()}</p>
                  </div>
                </div>

                {/* Event Details */}
                <div className="p-4">
                  <p className="text-lg font-semibold text-gray-800 truncate">
                    {event.title}
                  </p>
                  <p className="mt-2 text-sm text-gray-600 truncate">
                    <strong>Venue:</strong> {event.venueName ?? event.city}
                  </p>
                  <p className="mt-1 text-sm text-gray-600 truncate">
                    <strong>Type:</strong> {event.isFree ? "FREE" : "PAID"}
                  </p>
                  <p className="mt-3 text-sm text-gray-500 line-clamp-2">
                    {event.summary || "No additional description available."}
                  </p>
                </div>

                {/* CTA Button */}
                <div className="p-4 bg-gray-100 text-center">
                  <span className="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg shadow-sm group-hover:bg-blue-700 transition">
                    View Details
                  </span>
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex justify-center items-center space-x-2 mt-10">
            <button
              onClick={prevPage}
              disabled={currentPage === 1}
              className={`px-4 py-2 text-sm font-medium rounded-lg ${
                currentPage === 1
                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              Previous
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
              <button
                key={page}
                onClick={() => goToPage(page)}
                className={`px-4 py-2 text-sm font-medium rounded-lg ${
                  page === currentPage
                    ? "bg-blue-600 text-white"
                    : "bg-gray-200 text-gray-600 hover:bg-gray-300"
                }`}
              >
                {page}
              </button>
            ))}
            <button
              onClick={nextPage}
              disabled={currentPage === totalPages}
              className={`px-4 py-2 text-sm font-medium rounded-lg ${
                currentPage === totalPages
                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default EventsPage;
