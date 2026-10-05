// Shapes returned by the backend (see backend/src/serializers.js).

export interface TicketTypePublic {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  isFree: boolean;
  remaining: number;
  soldOut: boolean;
  minPerOrder: number;
  maxPerOrder: number;
}

export interface OrganizerPublic {
  id: string;
  slug: string;
  displayName: string;
  verified: boolean;
}

export interface Event {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  status: "PUBLISHED" | "COMPLETED" | "CANCELLED";
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  venueName: string | null;
  city: string | null;
  currency: string;
  coverImageUrl: string | null;
  organizer: OrganizerPublic | null;
  ticketTypes: TicketTypePublic[];
  soldOut: boolean;
  isFree: boolean;
  priceFromMinor: number | null;
}

export interface Ticket {
  id: string;
  code: string;
  status: "VALID" | "CANCELLED";
  checkedInAt: string | null;
  ticketType: { id: string; name: string } | null;
}

export interface Booking {
  id: string;
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
  currency: string;
  totalMinor: number;
  bookingDate: string;
  items: { ticketTypeId: string; ticketTypeName: string | null; quantity: number; unitPriceMinor: number }[];
  event: {
    id: string;
    slug: string;
    title: string;
    summary: string;
    status: string;
    startsAt: string;
    venueName: string | null;
    city: string | null;
    coverImageUrl: string | null;
  } | null;
  tickets: Ticket[];
}
