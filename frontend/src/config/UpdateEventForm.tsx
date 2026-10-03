import React, { useState, useEffect } from "react";
import { useEvent } from "../context/EventContext";

interface EventFormData {
  title: string;
  shortDescription: string;
  longDescription: string;
  date: string;
  venue: string;
  eventType: "FREE" | "PAID"; // Ensuring this is strictly typed
  price: number;
  capacity: number;
  availableTickets: number;
  adminId: string;
  pictureId: string;
  categories: string; // Stored as a comma-separated string
}

const UpdateEventForm: React.FC<{ eventId: string }> = ({ eventId }) => {
  const { updateEvent, events, loading, error } = useEvent();
  const [formData, setFormData] = useState<EventFormData>({
    title: "",
    shortDescription: "",
    longDescription: "",
    date: "",
    venue: "",
    eventType: "FREE", // Default to "FREE"
    price: 0, // Default to 0
    capacity: 0, // Default to 0
    availableTickets: 0,
    adminId: "",
    pictureId: "",
    categories: "",
  });

  useEffect(() => {
    const event = events?.find((e) => e.id === eventId);
    if (event) {
      setFormData({
        title: event.title,
        shortDescription: event.shortDescription,
        longDescription: event.longDescription,
        date: typeof event.date === "string" ? event.date : event.date.toISOString(),
        venue: event.venue,
        categories: Array.isArray(event.categories) ? event.categories.join(",") : "", // Handle categories array
        capacity: event.capacity ?? 0, // Default to 0 if capacity is missing
        price: event.price ?? 0, // Default to 0 if price is missing
        availableTickets: event.availableTickets ?? 0,
        adminId: event.admin || "",   // Map admin to adminId
        pictureId: event.pictureId[0] ?? "", // Form edits a single picture
        eventType: event.eventType === "PAID" || event.eventType === "FREE" ? event.eventType : "FREE", // Ensure eventType is valid
      });
    }
  }, [eventId, events]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateEvent(eventId, {
      ...formData,
      categories: formData.categories.split(","), // Split categories back to array
      admin: formData.adminId, // Map adminId to admin
      pictureId: formData.pictureId ? [formData.pictureId] : [],
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-2xl mx-auto p-6 bg-white shadow-lg rounded-md"
    >
      <h2 className="text-3xl font-bold text-indigo-600 mb-6">Update Event</h2>

      <div className="mb-4">
        <label htmlFor="title" className="block text-sm font-medium text-gray-700">
          Title
        </label>
        <input
          type="text"
          id="title"
          name="title"
          value={formData.title}
          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          required
        />
      </div>

      {/* Add other input fields similarly */}

      <div className="flex justify-between">
        <button
          type="submit"
          className="px-6 py-2 text-white bg-indigo-600 hover:bg-indigo-700 rounded-md"
          disabled={loading}
        >
          {loading ? "Updating..." : "Update Event"}
        </button>
        {error && <p className="text-red-600 text-sm">{error}</p>}
      </div>
    </form>
  );
};

export default UpdateEventForm;
