import React, { createContext, useContext, useState } from "react";

import { publicApi } from "../lib/api";
import type { Event } from "../types/Event";

// Context Props
interface EventContextProps {
  events: Event[] | null;
  loading: boolean;
  error: string | null;
  location: string;
  setLocation: (location: string) => void;
  fetchEventsByLocation: (searchLocation: string) => Promise<void>;
  fetchCurrentLocation: () => Promise<void>;
}

// Create Context
const EventContext = createContext<EventContextProps | undefined>(undefined);

// EventProvider Component
export const EventProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<string>("");

  // Fetch Events by Location (published, upcoming; matches city/venue/address)
  const fetchEventsByLocation = async (searchLocation: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = searchLocation.trim() ? `?location=${encodeURIComponent(searchLocation.trim())}` : "";
      setEvents(await publicApi<Event[]>(`/public/events${query}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Fetch Current Location
  // Reverse geocoding previously called OpenCage from the browser with a
  // hard-coded API key. That key was removed (see docs/SECURITY.md); geocoding
  // will move behind the backend in the search phase. Until then, ask the
  // user to type their city instead.
  const fetchCurrentLocation = async () => {
    setError(
      "Searching by your current location isn't available yet. Please type your city instead."
    );
  };
  
  return (
    <EventContext.Provider
      value={{
        events,
        loading,
        error,
        location,
        setLocation,
        fetchEventsByLocation,
        fetchCurrentLocation,
      }}
    >
      {children}
    </EventContext.Provider>
  );
};

// Custom Hook
export const useEvent = () => {
  const context = useContext(EventContext);
  if (!context) {
    throw new Error("useEvent must be used within an EventProvider");
  }
  return context;
};
