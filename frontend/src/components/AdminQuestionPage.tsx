import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useUserFlow } from "../context/UserFlowContext";

const AdminQuestionsPage: React.FC = () => {
  const navigate = useNavigate();
  const { state, setEvent } = useUserFlow();

  const {
    title = "",
    shortDescription = "",
    longDescription = "",
    date = "",
    venue = "",
    eventType = "FREE",
    price = "",
    capacity = "",
    availableTickets = "",
    category = [],
  } = state.event || {};

  // Define state only ONCE
  const [formData, setFormData] = useState<{
    title: string;
    shortDescription: string;
    longDescription: string;
    date: string;
    venue: string;
    eventType: string;
    price: string;
    capacity: string;
    availableTickets: string;
    category: string[];
    newCategory: string;
  }>({
    title,
    shortDescription,
    longDescription,
    date,
    venue,
    eventType,
    price,
    capacity,
    availableTickets,
    category: Array.isArray(category) ? category : [], // Ensure it's always an array
    newCategory: "",
  });
  

  const prevFormData = useRef(formData);

  // Sync formData with global state
  useEffect(() => {
    Object.entries(formData).forEach(([key, value]) => {
      if (
        key in prevFormData.current &&
        prevFormData.current[key as keyof typeof prevFormData.current] !== value
      ) {
        setEvent(key, Array.isArray(value) ? value.join(", ") : value);
      }
    });
    prevFormData.current = formData;
  }, [formData, setEvent]);

  // Handle input changes
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  // Handle adding a new category
  const handleAddCategory = () => {
    if (formData.newCategory.trim() && !formData.category.includes(formData.newCategory.trim())) {
      setFormData((prev) => ({
        ...prev,
        category: [...(prev.category || []), prev.newCategory.trim()], // Ensure it's an array
        newCategory: "",
      }));
    }
  };
  
  

  // Handle removing a category
  const handleRemoveCategory = (categoryToRemove: string) => {
    setFormData((prev) => ({
      ...prev,
      category: prev.category.filter((cat) => cat !== categoryToRemove),
    }));
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-6">
      <div className="p-8 bg-white shadow-lg rounded-md w-full max-w-5xl">
        <h1 className="text-3xl font-bold mb-8 text-gray-800 text-center">Event Details</h1>
        <form className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Event Title */}
          <div className="flex flex-col">
            <label htmlFor="title" className="font-semibold mb-2">
              Event Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="title"
              value={formData.title}
              onChange={handleChange}
              required
              className="px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Short Description */}
          <div className="flex flex-col">
            <label htmlFor="shortDescription" className="font-semibold mb-2">
              Short Description <span className="text-red-500">*</span>
            </label>
            <textarea
              name="shortDescription"
              value={formData.shortDescription}
              onChange={handleChange}
              required
              className="px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              rows={3}
            />
          </div>

          {/* Long Description */}
          <div className="flex flex-col">
            <label htmlFor="longDescription" className="font-semibold mb-2">
              Long Description <span className="text-red-500">*</span>
            </label>
            <textarea
              name="longDescription"
              value={formData.longDescription}
              onChange={handleChange}
              required
              className="px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              rows={4}
            />
          </div>

          {/* Date */}
          <div className="flex flex-col">
            <label htmlFor="date" className="font-semibold mb-2">
              Event Date <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              name="date"
              value={formData.date}
              onChange={handleChange}
              required
              className="px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Venue */}
          <div className="flex flex-col">
            <label htmlFor="venue" className="font-semibold mb-2">
              Venue <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="venue"
              value={formData.venue}
              onChange={handleChange}
              required
              className="px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Event Type */}
          <div className="flex flex-col">
            <label htmlFor="eventType" className="font-semibold mb-2">
              Event Type <span className="text-red-500">*</span>
            </label>
            <select
              name="eventType"
              value={formData.eventType}
              onChange={handleChange}
              required
              className="px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            >
              <option value="FREE">Free</option>
              <option value="PAID">Paid</option>
            </select>
          </div>

          {/* Ticket quantity */}
          <div className="flex flex-col">
            <label htmlFor="capacity" className="font-semibold mb-2">
              Number of Tickets <span className="text-red-500">*</span>
            </label>
            <input
              id="capacity"
              type="number"
              min={1}
              name="capacity"
              value={formData.capacity}
              onChange={handleChange}
              required
              className="px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Ticket price (paid events; requires a verified organizer) */}
          {formData.eventType === "PAID" && (
            <div className="flex flex-col">
              <label htmlFor="price" className="font-semibold mb-2">
                Ticket Price <span className="text-red-500">*</span>
              </label>
              <input
                id="price"
                type="number"
                min={0}
                step="0.01"
                name="price"
                value={formData.price}
                onChange={handleChange}
                required
                className="px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Paid tickets are available to verified organizers only.</p>
            </div>
          )}

          {/* Categories */}
          <div className="flex flex-col">
            <label htmlFor="category" className="font-semibold mb-2">
              Categories <span className="text-red-500">*</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {formData.category.map((cat, index) => (
                <div key={index} className="flex items-center gap-2 bg-blue-200 text-blue-700 px-3 py-1 rounded-full">
                  <span className="text-xs">{cat}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveCategory(cat)}
                    className="text-sm text-red-500 hover:text-red-800"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
            <input
              type="text"
              name="newCategory"
              value={formData.newCategory}
              onChange={handleChange}
              placeholder="Add a category"
              className="px-4 py-2 mt-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={handleAddCategory}
              className="mt-2 py-2 px-4 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition"
            >
              Add Category
            </button>
          </div>
        </form>

        <div className="flex mt-8 justify-between">
          <button onClick={() => navigate(-1)} className="py-2 px-6 bg-gray-500 text-white rounded-md hover:bg-gray-700 transition">
            Go Back
          </button>
          <button type="button" onClick={() => navigate("/summary")} className="py-2 px-6 bg-green-600 text-white rounded-md hover:bg-green-700 transition">
            Next
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdminQuestionsPage;
