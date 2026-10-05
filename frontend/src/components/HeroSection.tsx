import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { useEvent } from "../context/EventContext";

const HeroSection: React.FC = () => {
  const {
    location,
    setLocation,
    events,
    loading,
    error,
    fetchEventsByLocation,
    fetchCurrentLocation,
  } = useEvent();

  useEffect(() => {
    // const handleSearch = () => {
    if (location.trim() >= "") {
      fetchEventsByLocation(location);
    }

    // };
  }, [location]);

  return (
    <div className="h-full py-8 mb-10  mt-10 flex flex-col items-center px-4">
      <div className="text-center mt-10 md:mt-20">

        <div className="flex flex-col gap-y-1.5">
          <p className="text-sm text-gray-500">Event booking at its peak !!!</p>
          <h2 className="text-4xl md:text-5xl font-bold text-gray-800">
            Find and Book Events Near You
          </h2>
          <p className="text-gray-600 md:text-base text-sm mt-2">
            Discover amazing events in your city! Instantly book tickets for
            concerts, workshops, and more, and create unforgettable memories.
          </p>
        </div>

        <div className="flex flex-col md:flex-row mt-4 gap-2 justify-center items-center">
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location here"
            className="border border-gray-300 px-4 py-3 rounded-lg w-full md:w-72 focus:outline-none"
          />
          <button
            // onClick={handleSearch}
            className="bg-sky-800 text-white px-6 py-3 rounded-lg w-full md:w-auto hover:bg-sky-700"
          >
            Search
          </button>
        </div>

        <div className="mt-4">
          <button
            onClick={fetchCurrentLocation}
            className="text-blue-600 hover:underline"
          >
            📍 Near me
          </button>
        </div>

        {loading && (
          <div className="flex justify-center items-center h-screen">
            <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-blue-500"></div>
          </div>
        )}

        {error && <p className="text-red-500 mt-6 text-center">{error}</p>}

        {events && events.length > 0 && (
          <div className="mt-8">
            <h2 className="text-2xl font-semibold text-blue-900 mb-10 text-center">
              Events Near {location}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {events.map((event) => (
                <Link
                  to={`/event/${event.id}`}
                  key={event.id}
                  className="search-event bg-white p-6 rounded-lg shadow-md hover:shadow-lg transition-all duration-300 ease-in-out text-left"
                >
                  <h3 className="text-base font-medium text-black">
                    {event.title.toUpperCase()}
                  </h3>
                  <p className="text-xs text-gray-600">
                    {new Date(event.startsAt).toDateString()}
                  </p>
                  <p className="text-gray-600">{event.isFree ? "FREE" : "PAID"}</p>
                  <p className="text-semibold text-xs">{event.venueName ?? event.city}</p>
                </Link>
              ))}
            </div>
          </div>
        )}

        {events && events.length === 0 && (
          <p className="mt-6 text-gray-600 text-center">
            No events found for{" "}
            <span className="font-semibold text-blue-700">{location}</span>.
          </p>
        )}
      </div>
    </div>
  );
};

export default HeroSection;
