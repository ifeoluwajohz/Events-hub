import React, { createContext, useContext, useState } from "react";
// import { useAuth } from "./AuthContext"; // Adjust the path as needed
import { useNavigate } from "react-router-dom"
import { publicApi, useApi } from "../lib/api";

interface UserFlowState {
  role: string | null;
  preferredName: string | null;
  location: string | null;
  event: Record<string, string>;
  categories: string[];
  selectedCategories: string[];
}

const initialState: UserFlowState = {
  role: null,
  preferredName: null,
  location: null,
  event: {},
  categories: [],
  selectedCategories: [],
};

interface UserFlowContextProps {
  state: UserFlowState;
  setRole: (role: string) => void;
  setPreferredName: (preferredName: string) => void;
  setLocation: (location: string) => void;
  setEvent: (question: string, answer: string) => void;
  setCategories: (categories: string[]) => void;
  addCategory: (category: string) => void;
  setSelectedCategories: (categories: string[]) => void;
  reset: () => void;
  syncWithBackend: () => Promise<void>;
}

const UserFlowContext = createContext<UserFlowContextProps | undefined>(
  undefined
);

export const UserFlowProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // const { userProfile } = useAuth();
  const [state, setState] = useState<UserFlowState>(initialState);
  const navigate = useNavigate();

  const setRole = (role: string) => setState((prev) => ({ ...prev, role }));
  const setPreferredName = (preferredName: string) =>
    setState((prev) => ({ ...prev, preferredName }));
  const setLocation = (location: string) => setState((prev) => ({ ...prev, location }));

  const setEvent = (question: string, answer: string) =>
    setState((prev) => ({
      ...prev,
      event: { ...prev.event, [question]: answer },
    }));
  const setCategories = (categories: string[]) =>
    setState((prev) => ({ ...prev, categories }));
  const addCategory = (category: string) =>
    setState((prev) => ({
      ...prev,
      selectedCategories: prev.selectedCategories.includes(category)
        ? prev.selectedCategories
        : [...prev.selectedCategories, category],
    }));
  const setSelectedCategories = (categories: string[]) =>
    setState((prev) => ({ ...prev, selectedCategories: categories }));
  const reset = () => setState(initialState);

  const api = useApi();

  // Creates the event through the organizer API and submits it for moderation.
  // Errors propagate to the caller (SummaryPage) so the user sees them.
  const syncWithBackend = async (): Promise<void> => {
    const e = state.event;
    const me = await api<{ organizer: { id: string } | null; displayName: string | null; name: string | null }>("/me");
    if (!me.organizer) {
      await api("/organizer", { method: "POST", body: { displayName: me.displayName || me.name || "My events" } });
    }

    // Categories are platform-managed: match the typed names, ignore unknown ones.
    const categories = await publicApi<{ id: string; name: string; slug: string }[]>("/public/categories");
    const wanted = (e.category || "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    const categoryIds = categories
      .filter((c) => wanted.includes(c.name.toLowerCase()) || wanted.includes(c.slug))
      .map((c) => c.id)
      .slice(0, 5);

    const isPaid = e.eventType === "PAID";
    const created = await api<{ id: string }>("/organizer/events", {
      method: "POST",
      body: {
        title: e.title,
        summary: e.shortDescription,
        description: e.longDescription,
        // The form collects a date only; it is taken as local midnight.
        startsAt: new Date(`${e.date}T00:00:00`).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        venueName: e.venue,
        // This legacy form has no currency field yet; the API accepts any ISO 4217 code.
        currency: "NGN",
        categoryIds,
        ticketTypes: [
          {
            name: "General admission",
            priceMinor: isPaid ? Math.round(Number(e.price) * 100) : 0,
            quantityTotal: Number(e.capacity),
          },
        ],
      },
    });
    await api(`/organizer/events/${created.id}/submit`, { method: "POST" });
    alert("Your event was submitted for review. It will be published once a moderator approves it.");
    navigate("/");
  };

  return (
    <UserFlowContext.Provider
      value={{
        state,
        setRole,
        setPreferredName,
        setLocation,
        setEvent,
        setCategories,
        addCategory,
        setSelectedCategories,
        reset,
        syncWithBackend,
      }}
    >
      {children}
    </UserFlowContext.Provider>
  );
};

export const useUserFlow = (): UserFlowContextProps => {
  const context = useContext(UserFlowContext);
  if (!context) {
    throw new Error("useUserFlow must be used within a UserFlowProvider");
  }
  return context;
};
