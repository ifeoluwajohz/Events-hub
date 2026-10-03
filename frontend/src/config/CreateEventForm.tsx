import React, { useState } from "react";
import { useEvent } from "../context/EventContext";

interface EventFormData {
  title: string;
  shortDescription: string;
  longDescription: string;
  date: string;
  venue: string;
  eventType: "FREE" | "PAID";
  price: number;
  availableTickets: number;
  admin: string;
  pictureId: string;
  categories: string;
  capacity: number;  // Add capacity here
}

const CreateEventForm: React.FC = () => {
  const { createEvent, loading, error } = useEvent();

  const [formData, setFormData] = useState<EventFormData>({
    title: "",
    shortDescription: "",
    longDescription: "",
    date: "",
    venue: "",
    eventType: "FREE",
    price: 0,
    availableTickets: 0,
    admin: "",
    pictureId: "",
    categories: "",
    capacity: 0,  // Initialize capacity
  });

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value as "FREE" | "PAID" }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await createEvent({
      ...formData,
      price: formData.eventType === "PAID" ? formData.price : 0,
      pictureId: formData.pictureId ? [formData.pictureId] : [],
      categories: formData.categories.split(","),
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-2xl mx-auto p-6 bg-white shadow-lg rounded-md space-y-6"
    >
      <h2 className="text-3xl font-bold text-indigo-600 mb-6">Create Event</h2>

      <div>
        <label className="block text-sm font-medium text-gray-700">Title</label>
        <input
          type="text"
          name="title"
          value={formData.title}
          onChange={handleChange}
          className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">
          Short Description
        </label>
        <textarea
          name="shortDescription"
          value={formData.shortDescription}
          onChange={handleChange}
          className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Other fields */}
      <div>
        <label className="block text-sm font-medium text-gray-700">Event Type</label>
        <select
          name="eventType"
          value={formData.eventType}
          onChange={handleSelectChange}
          className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="FREE">Free</option>
          <option value="PAID">Paid</option>
        </select>
      </div>

      {formData.eventType === "PAID" && (
        <div>
          <label className="block text-sm font-medium text-gray-700">Price</label>
          <input
            type="number"
            name="price"
            value={formData.price}
            onChange={handleChange}
            className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
            required={formData.eventType === "PAID"}
          />
        </div>
      )}

      {/* Capacity Field */}
      <div>
        <label className="block text-sm font-medium text-gray-700">Capacity</label>
        <input
          type="number"
          name="capacity"
          value={formData.capacity}
          onChange={handleChange}
          className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          required
        />
      </div>

      {/* Submit button */}
      <div className="flex justify-between items-center">
        <button
          type="submit"
          className="px-6 py-2 text-white bg-indigo-600 hover:bg-indigo-700 rounded-md"
          disabled={loading}
        >
          {loading ? "Creating..." : "Create Event"}
        </button>
        {error && <p className="text-red-600 text-sm">{error}</p>}
      </div>
    </form>
  );
};

export default CreateEventForm;
