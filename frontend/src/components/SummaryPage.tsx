import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUserFlow } from "../context/UserFlowContext";
import { FaArrowLeft, FaCheckCircle } from "react-icons/fa";
import { ApiError } from "../lib/api";

const SummaryPage: React.FC = () => {
  const { state, syncWithBackend } = useUserFlow();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoBack = () => navigate(-1);

  const handleSubmit = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await syncWithBackend();
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details)
        ? `: ${err.details.map((d: { path: string; message: string }) => `${d.path} ${d.message}`).join("; ")}`
        : "";
      setError(`${err instanceof Error ? err.message : "Submission failed"}${details}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-bl from-gray-900 to-black p-6">
      <div className="relative bg-white/10 shadow-2xl border border-gray-700 rounded-xl w-full max-w-3xl p-8 transition-transform hover:scale-[1.02]">
        
        {/* Header */}
        <h1 className="text-4xl font-bold text-white text-center mb-6 drop-shadow-md">
          Event Summary
        </h1>

        {/* Summary Card */}
        <div className="bg-white/10 p-6 rounded-lg border border-gray-600 shadow-lg">
          <h2 className="text-xl font-semibold text-white mb-4">Event Details</h2>
          
          <div className="grid grid-cols-2 gap-4 text-gray-200 text-sm">
            <div><span className="font-medium">Title:</span> {state?.event?.title || "N/A"}</div>
            <div><span className="font-medium">Date:</span> {state?.event?.date || "N/A"}</div>
            <div><span className="font-medium">Venue:</span> {state?.event?.venue || "N/A"}</div>
            <div><span className="font-medium">Type:</span> {state?.event?.eventType || "N/A"}</div>
            <div><span className="font-medium">Price:</span> {state?.event?.eventType === "PAID" && state?.event?.price ? state.event.price : "Free"}</div>
            <div><span className="font-medium">Capacity:</span> {state?.event?.capacity || "N/A"}</div>
            <div>
              <span className="font-medium">Category:</span>{" "}
              {Array.isArray(state?.event?.category) ? state.event.category.join(", ") : "N/A"}
            </div>

          </div>

          {/* Description */}
          <div className="mt-6">
            <h3 className="text-lg font-semibold text-white mb-2">Description</h3>
            <p className="text-gray-300 text-sm">{state?.event?.shortDescription || "No description available."}</p>
          </div>
        </div>

        {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}

        {/* Buttons */}
        <div className="flex justify-between mt-6">
          <button
            onClick={handleGoBack}
            className="w-1/2 py-3 flex items-center justify-center bg-gray-800 text-white font-medium rounded-lg hover:bg-gray-600 transition-all duration-300"
          >
            <FaArrowLeft className="mr-2" /> Go Back
          </button>
          <button
            onClick={handleSubmit}
            className={`w-1/2 py-3 flex items-center justify-center font-medium rounded-lg transition-all duration-300 ${
              isLoading
                ? "bg-green-400 cursor-not-allowed"
                : "bg-green-600 hover:bg-green-500 text-white"
            }`}
            disabled={isLoading}
          >
            {isLoading ? "Submitting..." : <><FaCheckCircle className="mr-2" /> Submit</>}
          </button>
        </div>

        {/* Submission Progress Indicator */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-xl">
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-white text-lg mt-3">Processing...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SummaryPage;
