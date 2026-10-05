import { useAuth } from "@clerk/clerk-react";
import { useCallback } from "react";

// Single API client. Identity is the Clerk session token; the client never sends
// user ids, roles or prices as proof of anything.
const API_URL = import.meta.env.VITE_REACT_APP_API_KEY;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; token?: string | null };

export async function apiRequest<T>(path: string, { method = "GET", body, token }: Options = {}): Promise<{ data: T; nextCursor?: string | null }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { data: undefined as T };
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return json;
}

/** Public (unauthenticated) request. */
export const publicApi = <T>(path: string) => apiRequest<T>(path).then((r) => r.data);

/** Authenticated request bound to the current Clerk session. */
export function useApi() {
  const { getToken } = useAuth();
  return useCallback(
    async <T,>(path: string, options: Omit<Options, "token"> = {}) => {
      const token = await getToken();
      if (!token) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in");
      return (await apiRequest<T>(path, { ...options, token })).data;
    },
    [getToken],
  );
}

/** Formats integer minor units, e.g. 250000 NGN -> "₦2,500.00". */
export function formatMoney(minor: number, currency: string): string {
  if (minor === 0) return "Free";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export const newIdempotencyKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
